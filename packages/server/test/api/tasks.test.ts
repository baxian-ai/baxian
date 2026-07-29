import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TaskState } from '../../src/shared/index.js';
import { ApiError } from '../../src/errors.js';
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

describe('POST /api/tasks with images', () => {
  it('decodes images and passes {bytes, ext} to createAndStartTask', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockResolvedValue(makeTask({ id: 'task-001', phase: 'code', images: ['x.png'] }));
    const res = await post('/api/tasks', createPayload({ images: [{ dataBase64: PNG_B64 }] }));
    expect(res.statusCode).toBe(201);
    const arg = spy.mock.calls[0][1] as { images?: { bytes: Buffer; ext: string }[] };
    expect(arg.images).toHaveLength(1);
    expect(arg.images![0].ext).toBe('png');
    expect(arg.images![0].bytes.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
  });

  it('accepts exactly the max legal image count', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockResolvedValue(makeTask({ id: 'task-001', phase: 'code' }));
    const images = Array.from({ length: TASK_IMAGE_MAX_COUNT }, () => ({ dataBase64: PNG_B64 }));
    const res = await post('/api/tasks', createPayload({ images }));
    expect(res.statusCode).toBe(201);
    expect((spy.mock.calls[0][1] as { images?: unknown[] }).images).toHaveLength(TASK_IMAGE_MAX_COUNT);
  });

  it.each([
    ['more than the max image count', () => Array.from({ length: TASK_IMAGE_MAX_COUNT + 1 }, () => ({ dataBase64: PNG_B64 }))],
    ['a non-image payload', () => [{ dataBase64: Buffer.from('not an image').toString('base64') }]],
    ['an oversized image', () => {
      const big = Buffer.alloc(IMAGE_UPLOAD_MAX_BYTES + 16);
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(big);
      return [{ dataBase64: big.toString('base64') }];
    }],
  ] as const)('rejects %s with 400 and does not dispatch', async (_label, buildImages) => {
    const spy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask');
    const res = await post('/api/tasks', createPayload({ images: buildImages() }));
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
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
  it('happy: title + description + preferredAgentId → 201 + manager called with trimmed fields', async () => {
    const created = makeTask({
      id: 'task-100',
      title: 'New manual task',
      description: 'do the thing',
      status: 'in_progress',
    });
    const spy = vi
      .spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockResolvedValue(created);

    const response = await post('/api/tasks', createPayload({
      title: 'New manual task',
      description: 'do the thing',
    }));

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.id).toBe('task-100');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('proj', {
      title: 'New manual task',
      description: 'do the thing',
      preferredAgentId: 'dev-1',
    }, { background: true });
  });

  it('passes branch to createAndStartTask when provided', async () => {
    const spy = vi
      .spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockResolvedValue(makeTask({ id: 'task-branch', branch: 'feat/custom' }));

    const response = await post('/api/tasks', createPayload({
      title: 'custom branch task',
      description: 'details',
      branch: 'feat/custom',
    }));

    expect(response.statusCode).toBe(201);
    expect(spy).toHaveBeenCalledWith('proj', expect.objectContaining({
      branch: 'feat/custom',
    }), { background: true });
  });

  it('opts into background bootstrap so the response does not block on agent startup', async () => {
    const spy = vi
      .spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockResolvedValue(makeTask({ id: 'task-bg', status: 'in_progress' }));

    const response = await post('/api/tasks', createPayload());

    expect(response.statusCode).toBe(201);
    expect(spy).toHaveBeenLastCalledWith('proj', expect.any(Object), { background: true });
  });

  it('服务端归一化：title/description 带前后空白 → 落盘 trim 后值', async () => {
    const spy = vi
      .spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockResolvedValue(makeTask({ id: 'task-101', title: 'hello' }));

    const response = await post('/api/tasks', createPayload({ title: '  hello  ', description: '  body  ' }));

    expect(response.statusCode).toBe(201);
    expect(spy).toHaveBeenCalledWith('proj', {
      title: 'hello',
      description: 'body',
      preferredAgentId: 'dev-1',
    }, { background: true });
  });

  it.each([
    ['omitted', { description: undefined }, 'task-no-desc'],
    ['all-whitespace', { description: '   ' }, 'task-ws-desc'],
  ] as const)('description %s → 201 + manager 收到空描述', async (_label, overrides, id) => {
    const spy = vi
      .spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockResolvedValue(makeTask({ id }));

    const response = await post('/api/tasks', createPayload(overrides));

    expect(response.statusCode).toBe(201);
    expect(spy).toHaveBeenCalledWith(
      'proj',
      expect.objectContaining({ description: '' }),
      { background: true },
    );
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
  ] as const)('validation %s', async (_label, body, status, errorMatch) => {
    const response = await post('/api/tasks', body);
    expectStatus(response, status, errorMatch);
  });

  it('preferredAgentId provided but number → 400 (do not silently coerce to unassigned)', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask');
    const response = await post('/api/tasks', createPayload({ preferredAgentId: 42 }));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/preferredAgentId must be a string/);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['missing preferredAgentId → 201', { projectId: 'proj', title: 't', description: 'd' }, 'task-unassigned'],
    ['empty preferredAgentId → 201', createPayload({ preferredAgentId: '' }), 'task-empty'],
    ['whitespace preferredAgentId → 201', createPayload({ preferredAgentId: '   ' }), 'task-ws'],
  ] as const)('unassigned create %s', async (_label, body, id) => {
    vi.spyOn(app.ctx.agentManager, 'createAndStartTask').mockResolvedValue(
      makeTask({ id, preferredAgentId: '', agentId: '', status: 'pending', branch: '' }),
    );
    const response = await post('/api/tasks', body);
    expect(response.statusCode).toBe(201);
  });

  it('projectId 前后 whitespace → trim 后 lookup', async () => {
    const createSpy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask').mockResolvedValue(
      makeTask({ id: 'task-y', projectId: 'proj', status: 'pending', branch: '' }),
    );
    const response = await post('/api/tasks', createPayload({ projectId: '  proj  ' }));
    expect(response.statusCode).toBe(201);
    expect(createSpy).toHaveBeenCalledWith('proj', expect.anything(), { background: true });
  });

  it('preferredAgentId 前后 whitespace → trim 后传给 manager', async () => {
    const createSpy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask').mockResolvedValue(
      makeTask({ id: 'task-x', preferredAgentId: 'dev-1', status: 'pending', branch: '' }),
    );
    const response = await post('/api/tasks', createPayload({ preferredAgentId: '  dev-1  ' }));
    expect(response.statusCode).toBe(201);
    expect(createSpy).toHaveBeenCalledWith('proj', expect.objectContaining({
      preferredAgentId: 'dev-1',
    }), { background: true });
  });

  it('preferredAgentId 不存在的 agent → 400（manager 抛 ApiError 透传）', async () => {
    vi.spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockRejectedValue(new ApiError(400, 'Unknown agent: nope'));

    const response = await post('/api/tasks', createPayload({ preferredAgentId: 'nope' }));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/Unknown agent/);
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
      actorId: '  77  ',
      note: '  verified delivery  ',
    });

    expect(response.statusCode).toBe(202);
    expect(spy).toHaveBeenCalledWith('task-001', {
      executor: 'qa',
      prNumber: 73,
      stage: 'spec',
      actorId: '77',
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
    [{ actorId: '' }, 'actorId must be'],
    [{ actorId: 77 }, 'actorId must be'],
    [{ prNumber: 0 }, 'prNumber must be'],
    [{ confirmRevoked: 'yes' }, 'confirmRevoked must be'],
    [{ note: 7 }, 'note must be'],
  ])('rejects invalid selector %# before advancing', async (body, message) => {
    const spy = vi.spyOn(app.ctx.agentManager, 'advanceTask');
    const response = await post('/api/tasks/task-001/advance', body);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain(message);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not reset reconciler budgets when the advance is rejected', async () => {
    vi.spyOn(app.ctx.agentManager, 'advanceTask')
      .mockRejectedValue(new ApiError(409, 'Task cannot advance'));
    const resetTask = vi.fn();
    app.ctx.dispatchReconciler = { resetTask, stop: vi.fn() } as never;

    const response = await post('/api/tasks/task-001/advance', { executor: 'dev' });

    expect(response.statusCode).toBe(409);
    expect(resetTask).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/retry', () => {
  it('terminal task → 201 and audits the original task with the replacement id', async () => {
    const source = makeTask({ id: 'task-001', status: 'failed' });
    const fresh = makeTask({ id: 'task-fresh', status: 'in_progress' });
    vi.spyOn(app.ctx.agentManager, 'getTask').mockResolvedValue(source);
    const spy = vi.spyOn(app.ctx.agentManager, 'retryTask').mockResolvedValue(fresh);
    const audit = vi.spyOn(app.ctx.agentManager, 'auditHumanTaskOperation').mockResolvedValue();

    const response = await post('/api/tasks/task-001/retry');

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.id).toBe('task-fresh');
    expect(spy).toHaveBeenCalledWith('task-001');
    expect(audit).toHaveBeenCalledWith(
      source,
      'retry',
      'retry',
      undefined,
      { replacementTaskId: 'task-fresh' },
    );
  });

  it('non-terminal task → 409 (ApiError pass-through from manager.retryTask)', async () => {
    vi.spyOn(app.ctx.agentManager, 'getTask')
      .mockResolvedValue(makeTask({ id: 'task-001', status: 'in_progress' }));
    vi.spyOn(app.ctx.agentManager, 'retryTask')
      .mockRejectedValue(new ApiError(409, 'Task task-001 cannot be retried in status "in_progress"'));

    const response = await post('/api/tasks/task-001/retry');

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/cannot be retried/);
  });

  it('unknown task → 404', async () => {
    const retry = vi.spyOn(app.ctx.agentManager, 'retryTask');

    const response = await post('/api/tasks/task-missing/retry');

    expect(response.statusCode).toBe(404);
    expect(retry).not.toHaveBeenCalled();
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
  ])('rejects invalid payload %#', async (body, message) => {
    const spy = vi.spyOn(app.ctx.agentManager, 'submitTaskVerdict');
    const response = await post('/api/tasks/task-001/verdict', body);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain(message);
    expect(spy).not.toHaveBeenCalled();
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
  it('改 title → 200 + editTask 收到 trimmed patch', async () => {
    const updated = makeTask({ id: 'task-001', phase: 'code', status: 'pending', title: 'new title' });
    const spy = vi.spyOn(app.ctx.agentManager, 'editTask').mockResolvedValue(updated);

    const response = await patch('/api/tasks/task-001', { title: '  new title  ' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.title).toBe('new title');
    expect(spy).toHaveBeenCalledWith('task-001', { title: 'new title' });
  });

  it('改 description → 200 + editTask 收到 trimmed', async () => {
    const updated = makeTask({ id: 'task-001', phase: 'code', status: 'pending', description: 'new desc' });
    const spy = vi.spyOn(app.ctx.agentManager, 'editTask').mockResolvedValue(updated);

    const response = await patch('/api/tasks/task-001', { description: '  new desc  ' });

    expect(response.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith('task-001', { description: 'new desc' });
  });

  it('清空 description → 200 + editTask 收到空串', async () => {
    const updated = makeTask({ id: 'task-001', phase: 'code', status: 'pending', description: '' });
    const spy = vi.spyOn(app.ctx.agentManager, 'editTask').mockResolvedValue(updated);

    const response = await patch('/api/tasks/task-001', { description: '   ' });

    expect(response.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith('task-001', { description: '' });
  });

  it('改 preferredAgentId 立即重派 → 响应反映 manager refresh 后 in_progress + 新 dev', async () => {
    const refreshed = makeTask({
      id: 'task-001',
      phase: 'code',
      status: 'in_progress',
      preferredAgentId: 'dev-2',
      agentId: 'dev-2',
    });
    const spy = vi.spyOn(app.ctx.agentManager, 'editTask').mockResolvedValue(refreshed);

    const response = await patch('/api/tasks/task-001', { preferredAgentId: 'dev-2' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.status).toBe('in_progress');
    expect(body.agentId).toBe('dev-2');
    expect(spy).toHaveBeenCalledWith('task-001', { preferredAgentId: 'dev-2' });
  });

  it.each([
    ['title all-whitespace → 400 1-200', { title: '   ' }, /1-200/],
    ['title over 200 → 400', { title: 'x'.repeat(201) }, undefined],
    ['description non-string → 400', { description: 42 }, /description must be a string/],
    ['description over 16000 → 400 at most', { description: 'x'.repeat(16001) }, /at most 16000/],
    ['preferredAgentId null → 400', { preferredAgentId: null }, undefined],
    ["status 'failed' → 400 only cancelled accepted", { status: 'failed' }, /Only 'cancelled'/],
    ["title + status='cancelled' → 400 cannot combine", { title: 't', status: 'cancelled' }, /Cannot combine cancellation with edits/],
    ['empty body → 400 no fields to update', {}, /no fields to update/],
  ] as const)('validation %s', async (_label, body, errorMatch) => {
    const response = await patch('/api/tasks/task-001', body);
    expectStatus(response, 400, errorMatch);
  });

  it('preferredAgentId 空字符串 → 200（清空当前分配）', async () => {
    const cleared = makeTask({
      id: 'task-001',
      preferredAgentId: '',
      agentId: '',
      devAgentId: '',
      qaAgentId: undefined,
    });
    vi.spyOn(app.ctx.agentManager, 'editTask').mockResolvedValue(cleared);
    const response = await patch('/api/tasks/task-001', { preferredAgentId: '' });
    expect(response.statusCode).toBe(200);
  });

  it('preferredAgentId provided but number → 400 (do not coerce to empty/clear)', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'editTask');
    const response = await patch('/api/tasks/task-001', { preferredAgentId: 123 });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/preferredAgentId must be a string/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('in_progress 改 title → 409（editTask 抛 ApiError 透传）', async () => {
    vi.spyOn(app.ctx.agentManager, 'editTask')
      .mockRejectedValue(new ApiError(409, 'Task not editable in status in_progress'));

    const response = await patch('/api/tasks/task-001', { title: 'new' });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/not editable/);
  });

  it("body { status: 'cancelled' } → 200 + cancelTask 被调", async () => {
    const cancelled = makeTask({ id: 'task-001', phase: 'code', status: 'cancelled' });
    const spy = vi.spyOn(app.ctx.agentManager, 'cancelTask').mockResolvedValue(cancelled);

    const response = await patch('/api/tasks/task-001', { status: 'cancelled' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.status).toBe('cancelled');
    expect(spy).toHaveBeenCalledWith('task-001');
  });

  it('cancelled 后 PR 字段保留不变（来自 manager 的响应）', async () => {
    const cancelled = makeTask({
      id: 'task-001',
      phase: 'code',
      status: 'cancelled',
      prNumber: 42,
      prUrl: 'https://example.com/pr/42',
    });
    vi.spyOn(app.ctx.agentManager, 'cancelTask').mockResolvedValue(cancelled);

    const response = await patch('/api/tasks/task-001', { status: 'cancelled' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.prNumber).toBe(42);
    expect(body.prUrl).toBe('https://example.com/pr/42');
  });

  it("body { status: 'cancelled' } 但 task 已 merged → 409（cancelTask 抛 ApiError）", async () => {
    vi.spyOn(app.ctx.agentManager, 'cancelTask')
      .mockRejectedValue(new ApiError(409, 'Cannot cancel task in status merged'));

    const response = await patch('/api/tasks/task-001', { status: 'cancelled' });
    expect(response.statusCode).toBe(409);
  });

  it('未知 task → 404（manager 抛 ApiError 透传）', async () => {
    vi.spyOn(app.ctx.agentManager, 'editTask')
      .mockRejectedValue(new ApiError(404, 'Task not found'));

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

  it('previewPromptBytesForTaskInput returns over-limit → 400', async () => {
    vi.spyOn(app.ctx.agentManager, 'previewPromptBytesForTaskInput')
      .mockReturnValue(100 * 1024);

    const response = await post('/api/tasks', createPayload({
      title: 'tiny title',
      description: 'tiny body',
    }));

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/exceeds.*limit/);
    expect(body.error).toMatch(/AGENT_PHASES/);
  });

  it('previewPromptBytesForTaskInput throws (unknown agent) → 400', async () => {
    vi.spyOn(app.ctx.agentManager, 'previewPromptBytesForTaskInput')
      .mockImplementation(() => { throw new Error('Unknown agent: ghost'); });

    const response = await post('/api/tasks', createPayload({ preferredAgentId: 'ghost' }));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/Unknown agent/);
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

  const GIT_BINDING = { mode: 'git', repoKey: 'github.com/user/repo', tool: 'gh' };

  function spyLiveBinding(binding = GIT_BINDING) {
    return vi.spyOn(app.ctx.agentManager, 'platformBindingFields')
      .mockReturnValue({ platformBinding: binding });
  }

  it('git tasks render the driver timeline instead of the gh hardcoded path', async () => {
    await seedTask(app.ctx.taskStore, { id: 'git-ok', prNumber: 7, platformBinding: GIT_BINDING });
    const fakeDriver = {
      commentSources: [
        { key: 'issue-comments', argv: ['{binary}'], map: { id: 'id', body: 'body' } },
      ],
      runCommentSource: async () => [{ id: 'c1', body: 'from driver', createdAt: '2026-07-19T01:00:00Z' }],
    };
    const bindingSpy = spyLiveBinding();
    const spy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor')
      .mockReturnValue(fakeDriver as never);
    const res = await get('/api/tasks/git-ok/pr-review');
    const body = JSON.parse(res.body);
    expect(body.available).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ kind: 'issue-comment', body: 'from driver', sourceKey: 'issue-comments' });
    spy.mockRestore();
    bindingSpy.mockRestore();
  });

  it('git tasks without a resolvable driver report driver-unavailable', async () => {
    await seedTask(app.ctx.taskStore, { id: 'git-nodrv', prNumber: 7, platformBinding: GIT_BINDING });
    const bindingSpy = spyLiveBinding();
    const spy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(undefined);
    const res = await get('/api/tasks/git-nodrv/pr-review');
    expect(JSON.parse(res.body)).toMatchObject({ available: false, reason: 'driver-unavailable' });
    spy.mockRestore();
    bindingSpy.mockRestore();
  });

  it('a drifted platform binding never queries the live repo for a historical task', async () => {
    await seedTask(app.ctx.taskStore, { id: 'git-drift', prNumber: 7, status: 'merged', platformBinding: GIT_BINDING });
    const bindingSpy = spyLiveBinding({ mode: 'git', repoKey: 'github.com/user/other-repo', tool: 'gh' });
    const driverSpy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor');
    const res = await get('/api/tasks/git-drift/pr-review');
    expect(JSON.parse(res.body)).toMatchObject({ available: false, reason: 'driver-unavailable' });
    expect(driverSpy).not.toHaveBeenCalled();
    driverSpy.mockRestore();
    bindingSpy.mockRestore();
  });

  function countingDriver(): { driver: unknown; calls: number[] } {
    const calls: number[] = [];
    const driver = {
      commentSources: [{ key: 'issue-comments', argv: ['{binary}'], map: { id: 'id', body: 'body' } }],
      runCommentSource: async (_src: unknown, vars: { prNumber: number }) => {
        calls.push(vars.prNumber);
        return [{ id: 'c1', body: 'hi', createdAt: '2026-07-19T01:00:00Z' }];
      },
    };
    return { driver, calls };
  }

  it('serves consecutive same-revision GETs from cache: the driver runs once', async () => {
    const { driver, calls } = countingDriver();
    const bindingSpy = spyLiveBinding();
    const spy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(driver as never);
    await seedTask(app.ctx.taskStore, { id: 'git-cache', prNumber: 7, platformBinding: GIT_BINDING });
    await get('/api/tasks/git-cache/pr-review');
    const res = await get('/api/tasks/git-cache/pr-review');
    expect(calls).toEqual([7]);
    expect(JSON.parse(res.body).available).toBe(true);
    spy.mockRestore();
    bindingSpy.mockRestore();
  });

  it('rebuilds when a revision field changes (reviewDispatchedAt)', async () => {
    const { driver, calls } = countingDriver();
    const bindingSpy = spyLiveBinding();
    const spy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(driver as never);
    await seedTask(app.ctx.taskStore, { id: 'git-rev', prNumber: 7, platformBinding: GIT_BINDING });
    await get('/api/tasks/git-rev/pr-review');
    await seedTask(app.ctx.taskStore, {
      id: 'git-rev', prNumber: 7, platformBinding: GIT_BINDING,
      reviewDispatchedAt: '2026-07-01T00:00:00Z',
    });
    await get('/api/tasks/git-rev/pr-review');
    expect(calls).toEqual([7, 7]);
    spy.mockRestore();
    bindingSpy.mockRestore();
  });

  it('rebuilds against the new PR when only prNumber changes (PR rebind)', async () => {
    const { driver, calls } = countingDriver();
    const bindingSpy = spyLiveBinding();
    const spy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(driver as never);
    await seedTask(app.ctx.taskStore, { id: 'git-rebind', prNumber: 7, platformBinding: GIT_BINDING });
    await get('/api/tasks/git-rebind/pr-review');
    await seedTask(app.ctx.taskStore, { id: 'git-rebind', prNumber: 9, platformBinding: GIT_BINDING });
    const res = await get('/api/tasks/git-rebind/pr-review');
    expect(calls).toEqual([7, 9]);
    expect(JSON.parse(res.body).prNumber).toBe(9);
    spy.mockRestore();
    bindingSpy.mockRestore();
  });

  it('an active task reports fetchedAt, autoRefresh:true and the poll interval', async () => {
    const { driver } = countingDriver();
    const bindingSpy = spyLiveBinding();
    const spy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(driver as never);
    await seedTask(app.ctx.taskStore, { id: 'git-fresh', prNumber: 7, platformBinding: GIT_BINDING });
    const body = JSON.parse((await get('/api/tasks/git-fresh/pr-review')).body);
    expect(body.fetchedAt).toMatch(/^\d{4}-/);
    expect(body.autoRefresh).toBe(true);
    expect(body.autoRefreshIntervalMs).toBe(app.ctx.config.server.githubPollIntervalMs);
    spy.mockRestore();
    bindingSpy.mockRestore();
  });

  it('a terminal task reports autoRefresh:false without an interval', async () => {
    const { driver } = countingDriver();
    const bindingSpy = spyLiveBinding();
    const spy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(driver as never);
    await seedTask(app.ctx.taskStore, { id: 'git-done', prNumber: 7, status: 'merged', platformBinding: GIT_BINDING });
    const body = JSON.parse((await get('/api/tasks/git-done/pr-review')).body);
    expect(body.autoRefresh).toBe(false);
    expect(body.autoRefreshIntervalMs).toBeUndefined();
    spy.mockRestore();
    bindingSpy.mockRestore();
  });

  it('a live task whose PR is closed-unmerged reports autoRefresh:false (poller skips it)', async () => {
    const { driver } = countingDriver();
    const bindingSpy = spyLiveBinding();
    const spy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(driver as never);
    await seedTask(app.ctx.taskStore, {
      id: 'git-closed', prNumber: 7, status: 'review', platformBinding: GIT_BINDING,
      closedUnmergedAnchor: { prNumber: 7, generation: 1 },
    });
    const body = JSON.parse((await get('/api/tasks/git-closed/pr-review')).body);
    expect(body.autoRefresh).toBe(false);
    expect(body.autoRefreshIntervalMs).toBeUndefined();
    spy.mockRestore();
    bindingSpy.mockRestore();
  });

  it('a reopened PR (cleared anchor) resumes autoRefresh:true', async () => {
    const { driver } = countingDriver();
    const bindingSpy = spyLiveBinding();
    const spy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(driver as never);
    await seedTask(app.ctx.taskStore, {
      id: 'git-reopened', prNumber: 7, status: 'review', platformBinding: GIT_BINDING,
      closedUnmergedAnchor: { prNumber: 7, generation: 1, cleared: true },
    });
    const body = JSON.parse((await get('/api/tasks/git-reopened/pr-review')).body);
    expect(body.autoRefresh).toBe(true);
    expect(body.autoRefreshIntervalMs).toBe(app.ctx.config.server.githubPollIntervalMs);
    spy.mockRestore();
    bindingSpy.mockRestore();
  });
});

describe('POST /api/tasks/:id/pr-review/refresh', () => {
  const GIT_BINDING = { mode: 'git', repoKey: 'github.com/user/repo', tool: 'gh' };

  function spyLiveBinding() {
    return vi.spyOn(app.ctx.agentManager, 'platformBindingFields')
      .mockReturnValue({ platformBinding: GIT_BINDING });
  }

  function countingDriver(): { driver: unknown; calls: number[] } {
    const calls: number[] = [];
    const driver = {
      commentSources: [{ key: 'issue-comments', argv: ['{binary}'], map: { id: 'id', body: 'body' } }],
      runCommentSource: async (_src: unknown, vars: { prNumber: number }) => {
        calls.push(vars.prNumber);
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
    const bindingSpy = spyLiveBinding();
    const spy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(driver as never);
    await seedTask(app.ctx.taskStore, { id: 'git-force', prNumber: 7, platformBinding: GIT_BINDING });
    await get('/api/tasks/git-force/pr-review');
    const res = await post('/api/tasks/git-force/pr-review/refresh');
    expect(calls).toEqual([7, 7]);
    const body = JSON.parse(res.body);
    expect(body.available).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.fetchedAt).toMatch(/^\d{4}-/);
    spy.mockRestore();
    bindingSpy.mockRestore();
  });

  it('refreshes the entry the next GET is served from', async () => {
    const calls: number[] = [];
    let label = 'before';
    const driver = {
      commentSources: [{ key: 'issue-comments', argv: ['{binary}'], map: { id: 'id', body: 'body' } }],
      runCommentSource: async (_src: unknown, vars: { prNumber: number }) => {
        calls.push(vars.prNumber);
        return [{ id: 'c1', body: label, createdAt: '2026-07-19T01:00:00Z' }];
      },
    };
    const bindingSpy = spyLiveBinding();
    const spy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue(driver as never);
    await seedTask(app.ctx.taskStore, { id: 'git-swr', prNumber: 7, platformBinding: GIT_BINDING });
    await get('/api/tasks/git-swr/pr-review');
    label = 'after';
    await post('/api/tasks/git-swr/pr-review/refresh');
    const body = JSON.parse((await get('/api/tasks/git-swr/pr-review')).body);
    expect(calls).toEqual([7, 7]);
    expect(body.items[0].body).toBe('after');
    spy.mockRestore();
    bindingSpy.mockRestore();
  });

  it('available:false (no-pr) when the task has no PR', async () => {
    await seedTask(app.ctx.taskStore, { id: 'force-nopr' });
    const res = await post('/api/tasks/force-nopr/pr-review/refresh');
    expect(JSON.parse(res.body)).toMatchObject({ available: false, reason: 'no-pr' });
  });
});
