import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { TaskState } from '../../src/shared/index.js';
import {
  TASK_IMAGE_MAX_COUNT,
  IMAGE_UPLOAD_MAX_BYTES,
  TASK_CREATE_ROUTE_BODY_LIMIT,
  IMAGE_UPLOAD_ROUTE_BODY_LIMIT,
} from '../../src/shared/index.js';
import { expectStatus, requesters, setupApiHarness, teardownApiHarness, type ApiHarness } from './helpers.js';
import { makeTask } from '../helpers/fixtures.js';
import { seedTask } from '../helpers/manager-harness.js';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');

let harness: ApiHarness;
let app: FastifyInstance;
const { get, post, patch } = requesters(() => app);

beforeEach(async () => {
  harness = await setupApiHarness('tasks');
  app = harness.app;
});

afterEach(() => teardownApiHarness(harness));

function createPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { projectId: 'proj', title: 't', description: 'd', preferredAgentId: 'dev-1', ...overrides };
}

// Unassigned tasks are queued without starting an agent session, so the stored task is the whole outcome.
function unassignedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return createPayload({ preferredAgentId: '', ...overrides });
}

async function markDevBusy(): Promise<void> {
  await app.ctx.agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-busy', updatedAt: new Date().toISOString() });
}

async function storedTasks(): Promise<TaskState[]> {
  return app.ctx.taskStore.list();
}

describe('POST /api/tasks with images', () => {
  it('stores the decoded image bytes under the new task', async () => {
    const res = await post('/api/tasks', unassignedPayload({ images: [{ dataBase64: PNG_B64 }] }));
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as TaskState;
    expect(body.images).toHaveLength(1);
    expect(body.images![0]).toMatch(/\.png$/);
    const staged = await readFile(join(harness.tempDir, 'state', 'task-images', body.id, body.images![0]));
    expect(staged.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
    expect((await app.ctx.taskStore.get(body.id))?.images).toEqual(body.images);
  });

  it('accepts exactly the max legal image count', async () => {
    const images = Array.from({ length: TASK_IMAGE_MAX_COUNT }, () => ({ dataBase64: PNG_B64 }));
    const res = await post('/api/tasks', unassignedPayload({ images }));
    expect(res.statusCode).toBe(201);
    expect((JSON.parse(res.body) as TaskState).images).toHaveLength(TASK_IMAGE_MAX_COUNT);
  });

  it.each([
    ['more than the max image count', () => Array.from({ length: TASK_IMAGE_MAX_COUNT + 1 }, () => ({ dataBase64: PNG_B64 }))],
    ['a non-image payload', () => [{ dataBase64: Buffer.from('not an image').toString('base64') }]],
    ['an oversized image', () => {
      const big = Buffer.alloc(IMAGE_UPLOAD_MAX_BYTES + 16);
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(big);
      return [{ dataBase64: big.toString('base64') }];
    }],
  ] as const)('rejects %s with 400 and creates nothing', async (_label, buildImages) => {
    const res = await post('/api/tasks', createPayload({ images: buildImages() }));
    expect(res.statusCode).toBe(400);
    expect(await storedTasks()).toEqual([]);
  });

  it('route bodyLimits cover the max legal base64 payload', () => {
    expect(TASK_CREATE_ROUTE_BODY_LIMIT).toBeGreaterThanOrEqual(
      Math.ceil((TASK_IMAGE_MAX_COUNT * IMAGE_UPLOAD_MAX_BYTES * 4) / 3),
    );
    expect(IMAGE_UPLOAD_ROUTE_BODY_LIMIT).toBeGreaterThanOrEqual(
      Math.ceil((IMAGE_UPLOAD_MAX_BYTES * 4) / 3),
    );
  });
});

describe('GET /api/tasks', () => {
  it('缺 projectId → 400（全局查询已下线）', async () => {
    await seedTask(app.ctx.taskStore, {
      id: 'task-001',
      title: 'Sample task',
      description: 'sample description',
      phase: 'code',
    });
    const response = await get('/api/tasks');
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/projectId is required/);
  });

  it('projectId 全 whitespace → 400', async () => {
    const response = await get('/api/tasks?projectId=%20%20');
    expect(response.statusCode).toBe(400);
  });

  it('默认返回该项目的 open（active 在前 + pending）分页，已处理被排除', async () => {
    await seedTask(app.ctx.taskStore, { id: 'task-001', status: 'in_progress' });
    await seedTask(app.ctx.taskStore, { id: 'task-002', status: 'pending' });
    await seedTask(app.ctx.taskStore, { id: 'task-003', status: 'merged' });
    await seedTask(app.ctx.taskStore, { id: 'task-004', status: 'cancelled' });

    const response = await get('/api/tasks?projectId=proj');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { tasks: TaskState[]; hasMore: boolean; nextOffset: number };
    expect(body.tasks.map((t) => t.id)).toEqual(['task-001', 'task-002']);
    expect(body.hasMore).toBe(false);
    expect(body.nextOffset).toBe(2);
  });

  it('open 默认分页每页最多 20', async () => {
    for (let i = 1; i <= 25; i += 1) {
      await seedTask(app.ctx.taskStore, { id: `task-${String(i).padStart(3, '0')}`, status: 'pending' });
    }
    const response = await get('/api/tasks?projectId=proj');
    const body = JSON.parse(response.body) as { tasks: TaskState[]; hasMore: boolean; nextOffset: number };
    expect(body.tasks).toHaveLength(20);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(20);
  });

  it('open 查询按 projectId 隔离', async () => {
    await seedTask(app.ctx.taskStore, { id: 'task-001', projectId: 'proj', status: 'in_progress' });
    await seedTask(app.ctx.taskStore, { id: 'task-002', projectId: 'other', status: 'in_progress' });

    const response = await get('/api/tasks?projectId=proj');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { tasks: TaskState[] };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].projectId).toBe('proj');
  });

  describe('category=active', () => {
    it('只返回 active 任务，按 updatedAt 倒序，分页', async () => {
      await seedTask(app.ctx.taskStore, { id: 'task-001', status: 'in_progress', updatedAt: '2026-05-16T00:00:00Z' });
      await seedTask(app.ctx.taskStore, { id: 'task-002', status: 'review', updatedAt: '2026-05-18T00:00:00Z' });
      await seedTask(app.ctx.taskStore, { id: 'task-003', status: 'pending' });
      await seedTask(app.ctx.taskStore, { id: 'task-004', status: 'merged' });

      const response = await get('/api/tasks?projectId=proj&category=active');
      const body = JSON.parse(response.body) as { tasks: TaskState[] };
      expect(body.tasks.map((t) => t.id)).toEqual(['task-002', 'task-001']);
    });

    it('active 排序容忍无法解析的 updatedAt，不抛错', async () => {
      await seedTask(app.ctx.taskStore, { id: 'task-001', status: 'in_progress', updatedAt: '2026-05-16T00:00:00Z' });
      await seedTask(app.ctx.taskStore, { id: 'task-002', status: 'review', updatedAt: 'not-a-date' });

      const response = await get('/api/tasks?projectId=proj&category=active');
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { tasks: TaskState[] };
      expect(body.tasks.map((t) => t.id)).toEqual(expect.arrayContaining(['task-001', 'task-002']));
      expect(body.tasks).toHaveLength(2);
    });
  });

  describe('category=pending', () => {
    it('只返回 pending 任务，按 id 升序，分页', async () => {
      await seedTask(app.ctx.taskStore, { id: 'task-003', status: 'pending' });
      await seedTask(app.ctx.taskStore, { id: 'task-001', status: 'pending' });
      await seedTask(app.ctx.taskStore, { id: 'task-002', status: 'pending' });
      await seedTask(app.ctx.taskStore, { id: 'task-010', status: 'in_progress' });

      const response = await get('/api/tasks?projectId=proj&category=pending');
      const body = JSON.parse(response.body) as { tasks: TaskState[] };
      expect(body.tasks.map((t) => t.id)).toEqual(['task-001', 'task-002', 'task-003']);
    });
  });

  describe('status filter (CLI)', () => {
    it('honor 精确 status：只返回该状态的任务', async () => {
      await seedTask(app.ctx.taskStore, { id: 'task-001', status: 'pending' });
      await seedTask(app.ctx.taskStore, { id: 'task-002', status: 'in_progress' });
      await seedTask(app.ctx.taskStore, { id: 'task-003', status: 'review' });

      const response = await get('/api/tasks?projectId=proj&status=pending');
      const body = JSON.parse(response.body) as { tasks: TaskState[] };
      expect(body.tasks.map((t) => t.id)).toEqual(['task-001']);
    });

    it('未知 status → 400（不静默返回错误集合）', async () => {
      const response = await get('/api/tasks?projectId=proj&status=bogus');
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatch(/unknown status/);
    });
  });

  describe('category=done 分页', () => {
    it('只返回 terminal 任务，按 id 倒序，每页最多 20', async () => {
      for (let i = 1; i <= 25; i += 1) {
        await seedTask(app.ctx.taskStore, { id: `task-${String(i).padStart(3, '0')}`, status: 'merged' });
      }
      await seedTask(app.ctx.taskStore, { id: 'task-999', status: 'in_progress' });

      const response = await get('/api/tasks?projectId=proj&category=done');
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { tasks: TaskState[]; hasMore: boolean; nextOffset: number };
      expect(body.tasks).toHaveLength(20);
      expect(body.tasks[0].id).toBe('task-025');
      expect(body.tasks[19].id).toBe('task-006');
      expect(body.hasMore).toBe(true);
      expect(body.nextOffset).toBe(20);
      expect(body.tasks.every((t) => t.status === 'merged')).toBe(true);
    });

    it('第二页返回剩余项且 hasMore=false', async () => {
      for (let i = 1; i <= 25; i += 1) {
        await seedTask(app.ctx.taskStore, { id: `task-${String(i).padStart(3, '0')}`, status: 'failed' });
      }

      const response = await get('/api/tasks?projectId=proj&category=done&offset=20');
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { tasks: TaskState[]; hasMore: boolean; nextOffset: number };
      expect(body.tasks).toHaveLength(5);
      expect(body.tasks[0].id).toBe('task-005');
      expect(body.tasks[4].id).toBe('task-001');
      expect(body.hasMore).toBe(false);
      expect(body.nextOffset).toBe(25);
    });

    it('offset 超出范围 → 空页 + hasMore=false', async () => {
      await seedTask(app.ctx.taskStore, { id: 'task-001', status: 'merged' });
      const response = await get('/api/tasks?projectId=proj&category=done&offset=999');
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { tasks: TaskState[]; hasMore: boolean };
      expect(body.tasks).toHaveLength(0);
      expect(body.hasMore).toBe(false);
    });
  });
});

describe('GET /api/tasks/:id', () => {
  it('returns task details for known task', async () => {
    const task = makeTask({
      id: 'task-001',
      title: 'Sample task',
      description: 'sample description',
      phase: 'code',
    });
    await app.ctx.taskStore.set(task);

    const response = await get('/api/tasks/task-001');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as TaskState & Record<string, unknown>;
    expect(body.id).toBe('task-001');
    expect(body.title).toBe('Sample task');
  });

  it('exposes the active post-approve episode used by the trusted operator API', async () => {
    await seedTask(app.ctx.taskStore, {
      id: 'task-001',
      phase: 'code',
      status: 'approved',
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveToken: 'deadbeefcafe',
      postApprovePhase: 'delivered',
      pendingRedispatch: true,
      redispatchCount: 2,
    });

    const response = await get('/api/tasks/task-001');

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveToken: 'deadbeefcafe',
      postApprovePhase: 'delivered',
      pendingRedispatch: true,
      redispatchCount: 2,
    });
  });

  it('returns 404 for unknown task', async () => {
    const response = await get('/api/tasks/task-999');
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/tasks', () => {
  it('creates the task with trimmed title and description and returns the stored record', async () => {
    const response = await post('/api/tasks', unassignedPayload({
      title: '  New manual task  ',
      description: '  do the thing  ',
    }));

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as TaskState;
    expect(body).toMatchObject({
      projectId: 'proj', title: 'New manual task', description: 'do the thing', preferredAgentId: '', status: 'pending',
    });
    expect(await app.ctx.taskStore.get(body.id)).toEqual(body);
  });

  it('answers 201 while the assigned agent is still bootstrapping, then finishes the start in the background', async () => {
    let releaseStart!: () => void;
    let reached!: () => void;
    const reachedGate = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<never>((_, reject) => { releaseStart = () => reject(new Error('bootstrap aborted by test')); });
    // E2: API harness(createTestContext)不暴露 fake runner,tmux 会话边界只能在 manager 方法上替换
    vi.spyOn(app.ctx.agentManager, 'ensureSession').mockImplementation(() => { reached(); return gate; });

    const response = await post('/api/tasks', createPayload({ preferredAgentId: 'dev-1' }));
    expect(response.statusCode).toBe(201);
    const created = JSON.parse(response.body) as TaskState;
    expect(created.status).toBe('in_progress');
    expect(created.agentId).toBe('dev-1');

    await reachedGate;
    expect((await app.ctx.taskStore.get(created.id))?.status).toBe('in_progress');
    releaseStart();
    // rollback writes the task first and unbinds the agent last: wait for that terminal state, not the first write
    await vi.waitFor(async () => {
      expect((await app.ctx.taskStore.get(created.id))?.status).toBe('pending');
      expect((await app.ctx.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    }, { timeout: 5000, interval: 25 });
  });

  it('binds the task to a custom branch when one is provided', async () => {
    const response = await post('/api/tasks', unassignedPayload({ branch: 'feat/custom' }));

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.branch).toBe('feat/custom');
    expect(body.branchCreatedByBaxian).toBe(false);
  });

  it.each([
    ['omitted', { description: undefined }],
    ['all-whitespace', { description: '   ' }],
  ] as const)('description %s → 201 with an empty stored description', async (_label, overrides) => {
    const response = await post('/api/tasks', unassignedPayload(overrides));

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.description).toBe('');
    expect((await app.ctx.taskStore.get(body.id))?.description).toBe('');
  });

  it.each([
    ['missing title → 400', { projectId: 'proj', description: 'y', preferredAgentId: 'dev-1' }, 400, /title is required/],
    ['missing projectId → 400', { title: 't', description: 'd', preferredAgentId: 'dev-1' }, 400, undefined],
    ['projectId not found → 404', createPayload({ projectId: 'no-such' }), 404, undefined],
    ['title all-whitespace → 400 1-200', createPayload({ title: '   ' }), 400, /1-200/],
    ['title over 200 → 400 1-200', createPayload({ title: 'x'.repeat(201) }), 400, /1-200/],
    ['description non-string → 400', createPayload({ description: 42 }), 400, /description must be a string/],
    ['description over 16000 → 400 at most', createPayload({ description: 'x'.repeat(16001) }), 400, /at most 16000/],
    ['projectId all-whitespace → 400', createPayload({ projectId: '   ' }), 400, /projectId is required/],
    ['title with newline → 400 single line', createPayload({ title: 'line1\nline2' }), 400, /single line/],
    ['preferredAgentId null → 400', createPayload({ preferredAgentId: null }), 400, undefined],
    ['preferredAgentId object → 400', createPayload({ preferredAgentId: { id: 'x' } }), 400, undefined],
    ['preferredAgentId number → 400 (not coerced to unassigned)', createPayload({ preferredAgentId: 42 }), 400, /preferredAgentId must be a string/],
    ['preferredAgentId unknown agent → 400', createPayload({ preferredAgentId: 'nope' }), 400, /Unknown agent/],
  ] as const)('validation %s', async (_label, body, status, errorMatch) => {
    const response = await post('/api/tasks', body);
    expectStatus(response, status, errorMatch);
    expect(await storedTasks()).toEqual([]);
  });

  it.each([
    ['missing preferredAgentId', { projectId: 'proj', title: 't', description: 'd' }],
    ['empty preferredAgentId', createPayload({ preferredAgentId: '' })],
    ['whitespace preferredAgentId', createPayload({ preferredAgentId: '   ' })],
  ] as const)('%s → 201 queued without an agent', async (_label, body) => {
    const response = await post('/api/tasks', body);
    expect(response.statusCode).toBe(201);
    const created = JSON.parse(response.body) as TaskState;
    expect(created).toMatchObject({ status: 'pending', preferredAgentId: '', agentId: '' });
    expect((await app.ctx.taskStore.get(created.id))?.status).toBe('pending');
  });

  it('projectId 前后 whitespace → trim 后 lookup', async () => {
    const response = await post('/api/tasks', unassignedPayload({ projectId: '  proj  ' }));
    expect(response.statusCode).toBe(201);
    expect((JSON.parse(response.body) as TaskState).projectId).toBe('proj');
  });

  it('preferredAgentId 前后 whitespace → trim 后记为首选 agent', async () => {
    await markDevBusy();
    const response = await post('/api/tasks', createPayload({ preferredAgentId: '  dev-1  ' }));
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body) as TaskState).toMatchObject({ preferredAgentId: 'dev-1', status: 'pending' });
  });
});

describe('POST /api/tasks/:id/advance', () => {
  it('forwards an explicit QA delivery recovery and trims human inputs', async () => {
    const updated = makeTask({ id: 'task-001', status: 'review', phase: 'spec' });
    const spy = vi.spyOn(app.ctx.agentManager, 'advanceTask').mockResolvedValue(updated);
    const resetTask = vi.fn();
    app.ctx.dispatchReconciler = { resetTask, stop: vi.fn() } as never;

    const response = await post('/api/tasks/task-001/advance', {
      executor: 'qa',
      prNumber: 73,
      stage: 'spec',
      note: '  verified delivery  ',
    });

    expect(response.statusCode).toBe(202);
    expect(spy).toHaveBeenCalledWith('task-001', {
      executor: 'qa',
      prNumber: 73,
      stage: 'spec',
      note: 'verified delivery',
    });
    expect(resetTask).toHaveBeenCalledWith('task-001');
  });

  it('supports explicit confirmation for a revoked post-approve pass', async () => {
    const updated = makeTask({ id: 'task-001', status: 'approved' });
    const spy = vi.spyOn(app.ctx.agentManager, 'advanceTask').mockResolvedValue(updated);

    const response = await post('/api/tasks/task-001/advance', {
      executor: 'dev',
      confirmRevoked: true,
    });

    expect(response.statusCode).toBe(202);
    expect(spy).toHaveBeenCalledWith('task-001', {
      executor: 'dev',
      confirmRevoked: true,
    });
  });

  it.each([
    [{ executor: 'ops' }, 'executor must be'],
    [{ stage: 'design' }, 'stage must be'],
    [{ prNumber: 0 }, 'prNumber must be'],
    [{ confirmRevoked: 'yes' }, 'confirmRevoked must be'],
    [{ note: 7 }, 'note must be'],
  ])('rejects invalid selector %# before looking the task up', async (body, message) => {
    const response = await post('/api/tasks/task-missing/advance', body);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain(message);
  });

  it('does not reset reconciler budgets when the advance is rejected', async () => {
    await seedTask(app.ctx.taskStore, { id: 'task-001', status: 'merged' });
    const resetTask = vi.fn();
    app.ctx.dispatchReconciler = { resetTask, stop: vi.fn() } as never;

    const response = await post('/api/tasks/task-001/advance', { executor: 'dev' });

    expect(response.statusCode).toBe(409);
    expect((await app.ctx.taskStore.get('task-001'))?.status).toBe('merged');
    expect(resetTask).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/retry', () => {
  it('terminal task → 201 with a fresh queued task, the source linked and the retry audited', async () => {
    await markDevBusy();
    await seedTask(app.ctx.taskStore, { id: 'task-001', status: 'failed' });

    const response = await post('/api/tasks/task-001/retry');

    expect(response.statusCode).toBe(201);
    const fresh = JSON.parse(response.body) as TaskState;
    expect(fresh.id).not.toBe('task-001');
    expect(fresh).toMatchObject({ status: 'pending', preferredAgentId: 'dev-1', title: 'T', description: 'D' });
    expect((await app.ctx.taskStore.get('task-001'))?.replacementTaskId).toBe(fresh.id);
    const today = new Date().toISOString().slice(0, 10);
    const audit = (await app.ctx.eventLog.readDate(today))
      .filter(e => e.type === 'task.updated' && e.taskId === 'task-001' && e.data.operation === 'retry');
    expect(audit.map(e => e.data.replacementTaskId)).toEqual([fresh.id]);
  });

  it('non-terminal task → 409 and no replacement is created', async () => {
    await seedTask(app.ctx.taskStore, { id: 'task-001', status: 'in_progress' });

    const response = await post('/api/tasks/task-001/retry');

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/cannot be retried/);
    expect((await storedTasks()).map(t => t.id)).toEqual(['task-001']);
  });

  it('unknown task → 404', async () => {
    const response = await post('/api/tasks/task-missing/retry');
    expect(response.statusCode).toBe(404);
    expect(await storedTasks()).toEqual([]);
  });
});

describe('POST /api/tasks/:id/verdict', () => {
  it.each([
    ['approve', undefined],
    ['request-changes', '补充回滚方案'],
    ['pass', 'checked locally'],
    ['continue', undefined],
    ['complete', undefined],
    ['confirm-merge', undefined],
  ] as const)('accepts %s and routes it through the unified manager entry', async (action, comments) => {
    const updated = makeTask({ id: 'task-001', status: 'review' });
    const spy = vi.spyOn(app.ctx.agentManager, 'submitTaskVerdict').mockResolvedValue(updated);
    const response = await post('/api/tasks/task-001/verdict', {
      action,
      ...(comments ? { comments } : {}),
      note: 'operator decision',
    });
    expect(response.statusCode).toBe(202);
    expect(spy).toHaveBeenCalledWith('task-001', action, comments, 'operator decision');
  });

  it.each([
    [{}, 'action'],
    [[], 'JSON object'],
    [{ action: 'reject' }, 'action'],
    [{ action: 'pass', comments: 123 }, 'comments'],
    [{ action: 'pass', note: 123 }, 'note'],
  ])('rejects invalid payload %# before looking the task up', async (body, message) => {
    const response = await post('/api/tasks/task-missing/verdict', body);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain(message);
  });
});

describe('removed task operation endpoints', () => {
  it.each(['dispatch', 'review', 'continue', 'complete', 'spec'])(
    'does not retain a /%s compatibility alias',
    async (operation) => {
      const response = await post(`/api/tasks/task-001/${operation}`, {});
      expect(response.statusCode).toBe(404);
    },
  );
});

describe('PATCH /api/tasks/:id', () => {
  async function seedPending(over: Partial<TaskState> = {}): Promise<TaskState> {
    return seedTask(app.ctx.taskStore, {
      id: 'task-001', status: 'pending', preferredAgentId: '', agentId: '', devAgentId: '', qaAgentId: undefined, ...over,
    });
  }

  it.each([
    ['title', { title: '  new title  ' }, { title: 'new title' }],
    ['description', { description: '  new desc  ' }, { description: 'new desc' }],
    ['description cleared', { description: '   ' }, { description: '' }],
  ] as const)('edits %s with trimmed values and persists them', async (_label, body, expected) => {
    await seedPending();

    const response = await patch('/api/tasks/task-001', body);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject(expected);
    expect(await app.ctx.taskStore.get('task-001')).toMatchObject(expected);
  });

  it('改 preferredAgentId：trim 后经真实 manager 持久化，绑定 Agent Team 的 dev/qa 并清掉旧 phase', async () => {
    await seedPending({ phase: 'code' });

    const response = await patch('/api/tasks/task-001', { preferredAgentId: '  dev-1  ' });

    expect(response.statusCode).toBe(200);
    const expected = { preferredAgentId: 'dev-1', devAgentId: 'dev-1', qaAgentId: 'qa-1', status: 'pending' };
    const body = JSON.parse(response.body) as TaskState;
    expect(body).toMatchObject(expected);
    expect(body.phase).toBeUndefined();
    const stored = await app.ctx.taskStore.get('task-001');
    expect(stored).toMatchObject(expected);
    expect(stored?.phase).toBeUndefined();
  });

  it.each([
    ['title all-whitespace → 400 1-200', { title: '   ' }, /1-200/],
    ['title over 200 → 400', { title: 'x'.repeat(201) }, undefined],
    ['description non-string → 400', { description: 42 }, /description must be a string/],
    ['description over 16000 → 400 at most', { description: 'x'.repeat(16001) }, /at most 16000/],
    ['preferredAgentId null → 400', { preferredAgentId: null }, undefined],
    ['preferredAgentId number → 400 (not coerced to clear)', { preferredAgentId: 123 }, /preferredAgentId must be a string/],
    ["status 'failed' → 400 only cancelled accepted", { status: 'failed' }, /Only 'cancelled'/],
    ["title + status='cancelled' → 400 cannot combine", { title: 't', status: 'cancelled' }, /Cannot combine cancellation with edits/],
    ['empty body → 400 no fields to update', {}, /no fields to update/],
  ] as const)('validation %s leaves the task untouched', async (_label, body, errorMatch) => {
    const seeded = await seedPending({ title: 'keep', description: 'keep' });
    const response = await patch('/api/tasks/task-001', body);
    expectStatus(response, 400, errorMatch);
    expect(await app.ctx.taskStore.get('task-001')).toEqual(seeded);
  });

  it('preferredAgentId 空字符串 → 200（清空当前分配）', async () => {
    await markDevBusy();
    await seedPending({ preferredAgentId: 'dev-1', devAgentId: 'dev-1', qaAgentId: 'qa-1' });
    const response = await patch('/api/tasks/task-001', { preferredAgentId: '' });
    expect(response.statusCode).toBe(200);
    expect((await app.ctx.taskStore.get('task-001'))?.preferredAgentId).toBe('');
  });

  it('in_progress 改 title → 409, task untouched', async () => {
    const seeded = await seedTask(app.ctx.taskStore, { id: 'task-001', status: 'in_progress', title: 'keep' });

    const response = await patch('/api/tasks/task-001', { title: 'new' });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/not editable/);
    expect((await app.ctx.taskStore.get('task-001'))?.title).toBe(seeded.title);
  });

  it("body { status: 'cancelled' } → 200 and the task is persisted as cancelled", async () => {
    await seedPending();

    const response = await patch('/api/tasks/task-001', { status: 'cancelled' });
    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as TaskState).status).toBe('cancelled');
    expect((await app.ctx.taskStore.get('task-001'))?.status).toBe('cancelled');
  });

  it("body { status: 'cancelled' } keeps the published PR metadata on the cancelled task", async () => {
    await seedTask(app.ctx.taskStore, {
      id: 'task-001', status: 'pending', agentId: '', devAgentId: '', qaAgentId: undefined, preferredAgentId: '',
      prNumber: 55, prUrl: 'https://github.com/user/repo/pull/55',
    });

    const response = await patch('/api/tasks/task-001', { status: 'cancelled' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body) as TaskState).toMatchObject({
      status: 'cancelled', prNumber: 55, prUrl: 'https://github.com/user/repo/pull/55',
    });
    expect(await app.ctx.taskStore.get('task-001')).toMatchObject({
      status: 'cancelled', prNumber: 55, prUrl: 'https://github.com/user/repo/pull/55',
    });
  });

  it("body { status: 'cancelled' } on an already merged task → 200 without rewriting its status", async () => {
    await seedTask(app.ctx.taskStore, { id: 'task-001', status: 'merged', platformBinding: undefined });

    const response = await patch('/api/tasks/task-001', { status: 'cancelled' });
    expect(response.statusCode).toBe(200);
    expect((await app.ctx.taskStore.get('task-001'))?.status).toBe('merged');
  });

  it('未知 task → 404', async () => {
    const response = await patch('/api/tasks/no-such', { title: 't' });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/tasks - op-aware gates', () => {
  it('creationToken on agent → 201 (busy dev accepts queued task)', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      creationToken: 'tok',
      updatedAt: new Date().toISOString(),
    });

    const response = await post('/api/tasks', createPayload({
      title: 'should be queued',
      description: 'agent is still being created, but queue is allowed now',
    }));

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('pending');
    expect(body.agentId).toBe('');
    expect(body.preferredAgentId).toBe('dev-1');
  });

  it('task binding on agent → 201 (queues; dispatch-time gates availability)', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-busy',
      updatedAt: new Date().toISOString(),
    });

    const response = await post('/api/tasks', createPayload({
      title: 'should be queued',
      description: 'agent is bound to another task',
    }));

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('pending');
    expect(body.agentId).toBe('');
  });

  it('prompt size preview over-limit → 400', async () => {
    // 保留 stub：description 限 16000 字符，真实提示词到不了 80KB 上限
    vi.spyOn(app.ctx.agentManager, 'previewPromptBytesForTaskInput')
      .mockReturnValue(100 * 1024);

    const response = await post('/api/tasks', createPayload({
      title: 'tiny title',
      description: 'tiny body',
    }));

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/exceeds.*limit/);
    expect(body.error).toMatch(/task description or platform workflow instructions/);
  });

});

describe('GET /api/tasks/:id/pr-review', () => {
  it('404 when the task does not exist', async () => {
    const res = await get('/api/tasks/missing/pr-review');
    expect(res.statusCode).toBe(404);
  });

  it('available:false (no-pr) when the task has no PR', async () => {
    await seedTask(app.ctx.taskStore, { id: 'gh-nopr' });
    const res = await get('/api/tasks/gh-nopr/pr-review');
    expect(JSON.parse(res.body)).toMatchObject({ available: false, reason: 'no-pr' });
  });

  it('available:false (driver-unavailable) when the project is unresolvable', async () => {
    await seedTask(app.ctx.taskStore, { id: 'gh-other', projectId: 'ghost', prNumber: 3 });
    const res = await get('/api/tasks/gh-other/pr-review');
    expect(JSON.parse(res.body)).toMatchObject({ available: false, reason: 'driver-unavailable' });
  });

  it('the retired github-review path is gone (no alias route)', async () => {
    await seedTask(app.ctx.taskStore, { id: 'gh-old', prNumber: 7 });
    const res = await get('/api/tasks/gh-old/github-review');
    expect(res.statusCode).toBe(404);
  });

  // The harness project is https://github.com/user/repo, so this binding matches the live one.
  const GIT_BINDING = { repoKey: 'github.com/user/repo' };

  function useDriver(driver: unknown): void {
    vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(driver as never);
  }

  it('git tasks render the driver timeline instead of the gh hardcoded path', async () => {
    await seedTask(app.ctx.taskStore, { id: 'git-ok', prNumber: 7, platformBinding: GIT_BINDING });
    useDriver({
      commentSources: [
        { key: 'issue-comments', category: 'top-level' },
      ],
      listComments: async () => [{ id: 'c1', body: 'from driver', createdAt: '2026-07-19T01:00:00Z' }],
    });
    const res = await get('/api/tasks/git-ok/pr-review');
    const body = JSON.parse(res.body);
    expect(body.available).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ kind: 'issue-comment', body: 'from driver', sourceKey: 'issue-comments' });
  });

  it('git tasks without a resolvable driver report driver-unavailable', async () => {
    await seedTask(app.ctx.taskStore, { id: 'git-nodrv', prNumber: 7, platformBinding: GIT_BINDING });
    useDriver(undefined);
    const res = await get('/api/tasks/git-nodrv/pr-review');
    expect(JSON.parse(res.body)).toMatchObject({ available: false, reason: 'driver-unavailable' });
  });

  it('a drifted platform binding never queries the live repo for a historical task', async () => {
    await seedTask(app.ctx.taskStore, {
      id: 'git-drift', prNumber: 7, status: 'merged', platformBinding: { repoKey: 'github.com/user/other-repo' },
    });
    const { driver, calls } = countingDriver();
    useDriver(driver);
    const res = await get('/api/tasks/git-drift/pr-review');
    expect(JSON.parse(res.body)).toMatchObject({ available: false, reason: 'driver-unavailable' });
    expect(calls).toEqual([]);
  });

  function countingDriver(): { driver: unknown; calls: number[] } {
    const calls: number[] = [];
    const driver = {
      commentSources: [{ key: 'issue-comments', category: 'top-level' }],
      listComments: async (_src: unknown, prNumber: number) => {
        calls.push(prNumber);
        return [{ id: 'c1', body: 'hi', createdAt: '2026-07-19T01:00:00Z' }];
      },
    };
    return { driver, calls };
  }

  it('serves consecutive same-revision GETs from cache: the driver runs once', async () => {
    const { driver, calls } = countingDriver();
    useDriver(driver);
    await seedTask(app.ctx.taskStore, { id: 'git-cache', prNumber: 7, platformBinding: GIT_BINDING });
    await get('/api/tasks/git-cache/pr-review');
    const res = await get('/api/tasks/git-cache/pr-review');
    expect(calls).toEqual([7]);
    expect(JSON.parse(res.body).available).toBe(true);
  });

  it('rebuilds when a revision field changes (reviewDispatchedAt)', async () => {
    const { driver, calls } = countingDriver();
    useDriver(driver);
    await seedTask(app.ctx.taskStore, { id: 'git-rev', prNumber: 7, platformBinding: GIT_BINDING });
    await get('/api/tasks/git-rev/pr-review');
    await seedTask(app.ctx.taskStore, {
      id: 'git-rev', prNumber: 7, platformBinding: GIT_BINDING,
      reviewDispatchedAt: '2026-07-01T00:00:00Z',
    });
    await get('/api/tasks/git-rev/pr-review');
    expect(calls).toEqual([7, 7]);
  });

  it('rebuilds against the new PR when only prNumber changes (PR rebind)', async () => {
    const { driver, calls } = countingDriver();
    useDriver(driver);
    await seedTask(app.ctx.taskStore, { id: 'git-rebind', prNumber: 7, platformBinding: GIT_BINDING });
    await get('/api/tasks/git-rebind/pr-review');
    await seedTask(app.ctx.taskStore, { id: 'git-rebind', prNumber: 9, platformBinding: GIT_BINDING });
    const res = await get('/api/tasks/git-rebind/pr-review');
    expect(calls).toEqual([7, 9]);
    expect(JSON.parse(res.body).prNumber).toBe(9);
  });

  it('an active task reports fetchedAt, autoRefresh:true and the poll interval', async () => {
    const { driver } = countingDriver();
    useDriver(driver);
    await seedTask(app.ctx.taskStore, { id: 'git-fresh', prNumber: 7, platformBinding: GIT_BINDING });
    const body = JSON.parse((await get('/api/tasks/git-fresh/pr-review')).body);
    expect(body.fetchedAt).toMatch(/^\d{4}-/);
    expect(body.autoRefresh).toBe(true);
    expect(body.autoRefreshIntervalMs).toBe(app.ctx.config.server.platformPollIntervalMs);
  });

  it('a terminal task reports autoRefresh:false without an interval', async () => {
    const { driver } = countingDriver();
    useDriver(driver);
    await seedTask(app.ctx.taskStore, { id: 'git-done', prNumber: 7, status: 'merged', platformBinding: GIT_BINDING });
    const body = JSON.parse((await get('/api/tasks/git-done/pr-review')).body);
    expect(body.autoRefresh).toBe(false);
    expect(body.autoRefreshIntervalMs).toBeUndefined();
  });

  it('a live task whose PR is closed-unmerged reports autoRefresh:false (poller skips it)', async () => {
    const { driver } = countingDriver();
    useDriver(driver);
    await seedTask(app.ctx.taskStore, {
      id: 'git-closed', prNumber: 7, status: 'review', platformBinding: GIT_BINDING,
      closedUnmergedAnchor: { prNumber: 7, generation: 1 },
    });
    const body = JSON.parse((await get('/api/tasks/git-closed/pr-review')).body);
    expect(body.autoRefresh).toBe(false);
    expect(body.autoRefreshIntervalMs).toBeUndefined();
  });

  it('a reopened PR (cleared anchor) resumes autoRefresh:true', async () => {
    const { driver } = countingDriver();
    useDriver(driver);
    await seedTask(app.ctx.taskStore, {
      id: 'git-reopened', prNumber: 7, status: 'review', platformBinding: GIT_BINDING,
      closedUnmergedAnchor: { prNumber: 7, generation: 1, cleared: true },
    });
    const body = JSON.parse((await get('/api/tasks/git-reopened/pr-review')).body);
    expect(body.autoRefresh).toBe(true);
    expect(body.autoRefreshIntervalMs).toBe(app.ctx.config.server.platformPollIntervalMs);
  });
});

describe('POST /api/tasks/:id/pr-review/refresh', () => {
  const GIT_BINDING = { repoKey: 'github.com/user/repo' };

  function useDriver(driver: unknown): void {
    vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(driver as never);
  }

  function countingDriver(): { driver: unknown; calls: number[] } {
    const calls: number[] = [];
    const driver = {
      commentSources: [{ key: 'issue-comments', category: 'top-level' }],
      listComments: async (_src: unknown, prNumber: number) => {
        calls.push(prNumber);
        return [{ id: 'c1', body: 'hi', createdAt: '2026-07-19T01:00:00Z' }];
      },
    };
    return { driver, calls };
  }

  it('404 when the task does not exist', async () => {
    const res = await post('/api/tasks/missing/pr-review/refresh');
    expect(res.statusCode).toBe(404);
  });

  it('forces a rebuild past a warm same-revision cache entry', async () => {
    const { driver, calls } = countingDriver();
    useDriver(driver);
    await seedTask(app.ctx.taskStore, { id: 'git-force', prNumber: 7, platformBinding: GIT_BINDING });
    await get('/api/tasks/git-force/pr-review');
    const res = await post('/api/tasks/git-force/pr-review/refresh');
    expect(calls).toEqual([7, 7]);
    const body = JSON.parse(res.body);
    expect(body.available).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.fetchedAt).toMatch(/^\d{4}-/);
  });

  it('refreshes the entry the next GET is served from', async () => {
    const calls: number[] = [];
    let label = 'before';
    const driver = {
      commentSources: [{ key: 'issue-comments', category: 'top-level' }],
      listComments: async (_src: unknown, prNumber: number) => {
        calls.push(prNumber);
        return [{ id: 'c1', body: label, createdAt: '2026-07-19T01:00:00Z' }];
      },
    };
    useDriver(driver);
    await seedTask(app.ctx.taskStore, { id: 'git-swr', prNumber: 7, platformBinding: GIT_BINDING });
    await get('/api/tasks/git-swr/pr-review');
    label = 'after';
    await post('/api/tasks/git-swr/pr-review/refresh');
    const body = JSON.parse((await get('/api/tasks/git-swr/pr-review')).body);
    expect(calls).toEqual([7, 7]);
    expect(body.items[0].body).toBe('after');
  });

  it('available:false (no-pr) when the task has no PR', async () => {
    await seedTask(app.ctx.taskStore, { id: 'force-nopr' });
    const res = await post('/api/tasks/force-nopr/pr-review/refresh');
    expect(JSON.parse(res.body)).toMatchObject({ available: false, reason: 'no-pr' });
  });
});

describe('POST /api/tasks id allocation', () => {
  it('fails the request instead of overwriting an existing task when the directory read fails', async () => {
    await seedTask(app.ctx.taskStore, makeTask({ id: 'task-001', status: 'pending', title: 'keep me' }));
    vi.spyOn(app.ctx.taskStore, 'nextId').mockRejectedValueOnce(Object.assign(new Error('EIO: scandir'), { code: 'EIO' }));
    const res = await post('/api/tasks', createPayload({ preferredAgentId: '' }));
    expect(res.statusCode).toBe(500);
    expect((await app.ctx.taskStore.get('task-001'))?.title).toBe('keep me');
    expect((await app.ctx.taskStore.list()).map(t => t.id)).toEqual(['task-001']);
  });
});
