import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { TaskState } from '../../src/shared/index.js';
import { buildApp } from '../../src/app.js';
import { createTestContext } from '../helpers/context.js';
import { ApiError } from '../../src/errors.js';
import {
  TASK_IMAGE_MAX_COUNT,
  IMAGE_UPLOAD_MAX_BYTES,
  TASK_CREATE_ROUTE_BODY_LIMIT,
  IMAGE_UPLOAD_ROUTE_BODY_LIMIT,
} from '../../src/shared/index.js';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');

let tempDir: string;
let app: FastifyInstance;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-tasks-test-'));
  const ctx = await createTestContext(tempDir);
  app = await buildApp(ctx);
});

afterEach(async () => {
  await app.close();
  await rm(tempDir, { recursive: true });
});

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const now = new Date().toISOString();
  return {
    id: 'task-001',
    projectId: 'proj',
    title: 'Sample task',
    description: 'sample description',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    reviewRound: 0,
    status: 'in_progress',
    branch: 'bx/task-001',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('POST /api/tasks with images', () => {
  it('decodes images and passes {bytes, ext} to createAndStartTask', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockResolvedValue(makeTask({ images: ['x.png'] }));
    const res = await app.inject({
      method: 'POST', url: '/api/tasks',
      payload: { projectId: 'proj', title: 't', description: 'd', preferredAgentId: 'dev-1', images: [{ dataBase64: PNG_B64 }] },
    });
    expect(res.statusCode).toBe(201);
    const arg = spy.mock.calls[0][1] as { images?: { bytes: Buffer; ext: string }[] };
    expect(arg.images).toHaveLength(1);
    expect(arg.images![0].ext).toBe('png');
    expect(arg.images![0].bytes.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
  });

  it('accepts exactly the max legal image count', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask').mockResolvedValue(makeTask());
    const images = Array.from({ length: TASK_IMAGE_MAX_COUNT }, () => ({ dataBase64: PNG_B64 }));
    const res = await app.inject({
      method: 'POST', url: '/api/tasks',
      payload: { projectId: 'proj', title: 't', description: 'd', preferredAgentId: 'dev-1', images },
    });
    expect(res.statusCode).toBe(201);
    expect((spy.mock.calls[0][1] as { images?: unknown[] }).images).toHaveLength(TASK_IMAGE_MAX_COUNT);
  });

  it('rejects more than the max image count with 400 and does not dispatch', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask');
    const images = Array.from({ length: TASK_IMAGE_MAX_COUNT + 1 }, () => ({ dataBase64: PNG_B64 }));
    const res = await app.inject({
      method: 'POST', url: '/api/tasks',
      payload: { projectId: 'proj', title: 't', description: 'd', preferredAgentId: 'dev-1', images },
    });
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a non-image payload with 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/tasks',
      payload: {
        projectId: 'proj', title: 't', description: 'd', preferredAgentId: 'dev-1',
        images: [{ dataBase64: Buffer.from('not an image').toString('base64') }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversized image with 400', async () => {
    const big = Buffer.alloc(IMAGE_UPLOAD_MAX_BYTES + 16);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(big);
    const res = await app.inject({
      method: 'POST', url: '/api/tasks',
      payload: {
        projectId: 'proj', title: 't', description: 'd', preferredAgentId: 'dev-1',
        images: [{ dataBase64: big.toString('base64') }],
      },
    });
    expect(res.statusCode).toBe(400);
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
    await app.ctx.taskStore.set(makeTask());
    const response = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/projectId is required/);
  });

  it('projectId 全 whitespace → 400', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=%20%20' });
    expect(response.statusCode).toBe(400);
  });

  it('默认返回该项目的 open（active 在前 + pending）分页，已处理被排除', async () => {
    await app.ctx.taskStore.set(makeTask({ id: 'task-001', status: 'in_progress' }));
    await app.ctx.taskStore.set(makeTask({ id: 'task-002', status: 'pending' }));
    await app.ctx.taskStore.set(makeTask({ id: 'task-003', status: 'merged' }));
    await app.ctx.taskStore.set(makeTask({ id: 'task-004', status: 'cancelled' }));

    const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { tasks: TaskState[]; hasMore: boolean; nextOffset: number };
    expect(body.tasks.map((t) => t.id)).toEqual(['task-001', 'task-002']);
    expect(body.hasMore).toBe(false);
    expect(body.nextOffset).toBe(2);
  });

  it('open 默认分页每页最多 20', async () => {
    for (let i = 1; i <= 25; i += 1) {
      await app.ctx.taskStore.set(makeTask({ id: `task-${String(i).padStart(3, '0')}`, status: 'pending' }));
    }
    const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj' });
    const body = JSON.parse(response.body) as { tasks: TaskState[]; hasMore: boolean; nextOffset: number };
    expect(body.tasks).toHaveLength(20);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(20);
  });

  it('open 查询按 projectId 隔离', async () => {
    await app.ctx.taskStore.set(makeTask({ id: 'task-001', projectId: 'proj', status: 'in_progress' }));
    await app.ctx.taskStore.set(makeTask({ id: 'task-002', projectId: 'other', status: 'in_progress' }));

    const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { tasks: TaskState[] };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].projectId).toBe('proj');
  });

  it('does not expose post-approve completion secrets', async () => {
    await app.ctx.taskStore.set(makeTask({ status: 'in_progress' }));
    await app.ctx.agentManager.setPostApproveCompletion('task-001', {
      token: 'secret-token',
      approvedHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { tasks: Array<Record<string, unknown>> };
    expect(body.tasks[0].signalToken).toBeUndefined();
    expect(body.tasks[0].approvedHeadSha).toBeUndefined();
  });

  describe('category=active', () => {
    it('只返回 active 任务，按 updatedAt 倒序，分页', async () => {
      await app.ctx.taskStore.set(makeTask({ id: 'task-001', status: 'in_progress', updatedAt: '2026-05-16T00:00:00Z' }));
      await app.ctx.taskStore.set(makeTask({ id: 'task-002', status: 'review', updatedAt: '2026-05-18T00:00:00Z' }));
      await app.ctx.taskStore.set(makeTask({ id: 'task-003', status: 'pending' }));
      await app.ctx.taskStore.set(makeTask({ id: 'task-004', status: 'merged' }));

      const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj&category=active' });
      const body = JSON.parse(response.body) as { tasks: TaskState[] };
      expect(body.tasks.map((t) => t.id)).toEqual(['task-002', 'task-001']);
    });

    it('active 排序容忍缺失 updatedAt，不抛错', async () => {
      await app.ctx.taskStore.set(makeTask({ id: 'task-001', status: 'in_progress', updatedAt: '2026-05-16T00:00:00Z' }));
      await app.ctx.taskStore.set(
        makeTask({ id: 'task-002', status: 'review', updatedAt: undefined as unknown as string }),
      );

      const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj&category=active' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { tasks: TaskState[] };
      // the timestamped task sorts before the timestamp-less one under desc order.
      expect(body.tasks.map((t) => t.id)).toEqual(['task-001', 'task-002']);
    });
  });

  describe('category=pending', () => {
    it('只返回 pending 任务，按 id 升序，分页', async () => {
      await app.ctx.taskStore.set(makeTask({ id: 'task-003', status: 'pending' }));
      await app.ctx.taskStore.set(makeTask({ id: 'task-001', status: 'pending' }));
      await app.ctx.taskStore.set(makeTask({ id: 'task-002', status: 'pending' }));
      await app.ctx.taskStore.set(makeTask({ id: 'task-010', status: 'in_progress' }));

      const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj&category=pending' });
      const body = JSON.parse(response.body) as { tasks: TaskState[] };
      expect(body.tasks.map((t) => t.id)).toEqual(['task-001', 'task-002', 'task-003']);
    });
  });

  describe('status filter (CLI)', () => {
    it('honor 精确 status：只返回该状态的任务', async () => {
      await app.ctx.taskStore.set(makeTask({ id: 'task-001', status: 'pending' }));
      await app.ctx.taskStore.set(makeTask({ id: 'task-002', status: 'in_progress' }));
      await app.ctx.taskStore.set(makeTask({ id: 'task-003', status: 'review' }));

      const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj&status=pending' });
      const body = JSON.parse(response.body) as { tasks: TaskState[] };
      expect(body.tasks.map((t) => t.id)).toEqual(['task-001']);
    });

    it('未知 status → 400（不静默返回错误集合）', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj&status=bogus' });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatch(/unknown status/);
    });
  });

  describe('category=done 分页', () => {
    it('只返回 terminal 任务，按 id 倒序，每页最多 20', async () => {
      for (let i = 1; i <= 25; i += 1) {
        await app.ctx.taskStore.set(makeTask({
          id: `task-${String(i).padStart(3, '0')}`,
          status: 'merged',
        }));
      }
      // open 任务不应出现在 done 列表里
      await app.ctx.taskStore.set(makeTask({ id: 'task-999', status: 'in_progress' }));

      const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj&category=done' });
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
        await app.ctx.taskStore.set(makeTask({
          id: `task-${String(i).padStart(3, '0')}`,
          status: 'failed',
        }));
      }

      const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj&category=done&offset=20' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { tasks: TaskState[]; hasMore: boolean; nextOffset: number };
      expect(body.tasks).toHaveLength(5);
      expect(body.tasks[0].id).toBe('task-005');
      expect(body.tasks[4].id).toBe('task-001');
      expect(body.hasMore).toBe(false);
      expect(body.nextOffset).toBe(25);
    });

    it('offset 超出范围 → 空页 + hasMore=false', async () => {
      await app.ctx.taskStore.set(makeTask({ id: 'task-001', status: 'merged' }));
      const response = await app.inject({ method: 'GET', url: '/api/tasks?projectId=proj&category=done&offset=999' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { tasks: TaskState[]; hasMore: boolean };
      expect(body.tasks).toHaveLength(0);
      expect(body.hasMore).toBe(false);
    });
  });
});

describe('GET /api/tasks/:id', () => {
  it('returns task details for known task', async () => {
    const task = makeTask();
    await app.ctx.taskStore.set(task);
    await app.ctx.agentManager.setPostApproveCompletion(task.id, {
      token: 'secret-token',
      approvedHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    const response = await app.inject({ method: 'GET', url: '/api/tasks/task-001' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as TaskState & Record<string, unknown>;
    expect(body.id).toBe('task-001');
    expect(body.title).toBe('Sample task');
    expect(body.signalToken).toBeUndefined();
    expect(body.approvedHeadSha).toBeUndefined();
  });

  it('returns 404 for unknown task', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tasks/task-999' });
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

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 'New manual task',
        description: 'do the thing',
        preferredAgentId: 'dev-1',
      },
    });

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

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 'custom branch task',
        description: 'details',
        preferredAgentId: 'dev-1',
        branch: 'feat/custom',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(spy).toHaveBeenCalledWith('proj', expect.objectContaining({
      branch: 'feat/custom',
    }), { background: true });
  });

  it('opts into background bootstrap so the response does not block on agent startup', async () => {
    const spy = vi
      .spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockResolvedValue(makeTask({ id: 'task-bg', status: 'in_progress' }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { projectId: 'proj', title: 't', description: 'd', preferredAgentId: 'dev-1' },
    });

    expect(response.statusCode).toBe(201);
    expect(spy).toHaveBeenLastCalledWith('proj', expect.any(Object), { background: true });
  });

  it('服务端归一化：title/description 带前后空白 → 落盘 trim 后值', async () => {
    const spy = vi
      .spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockResolvedValue(makeTask({ id: 'task-101', title: 'hello' }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: '  hello  ',
        description: '  body  ',
        preferredAgentId: 'dev-1',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(spy).toHaveBeenCalledWith('proj', {
      title: 'hello',
      description: 'body',
      preferredAgentId: 'dev-1',
    }, { background: true });
  });

  it('同时传 title + issueNumber → 400 mutually exclusive', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 'x',
        description: 'y',
        preferredAgentId: 'dev-1',
        issueNumber: 5,
      },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/mutually exclusive/);
  });

  it('只传 issueNumber → 400 issue-bound 不再支持', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { projectId: 'proj', issueNumber: 5 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('缺 title → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        description: 'y',
        preferredAgentId: 'dev-1',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('缺 description → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 't',
        preferredAgentId: 'dev-1',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('缺 preferredAgentId → 201（允许 unassigned 创建）', async () => {
    vi.spyOn(app.ctx.agentManager, 'createAndStartTask').mockResolvedValue(
      makeTask({ id: 'task-unassigned', preferredAgentId: '', agentId: '', status: 'pending', branch: '' }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { projectId: 'proj', title: 't', description: 'd' },
    });
    expect(response.statusCode).toBe(201);
  });

  it('缺 projectId → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 't', description: 'd', preferredAgentId: 'dev-1' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('projectId 不存在 → 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'no-such',
        title: 't',
        description: 'd',
        preferredAgentId: 'dev-1',
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('title 全空白（trim 后空）→ 400 1-200 characters', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: '   ',
        description: 'd',
        preferredAgentId: 'dev-1',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/1-200/);
  });

  it('title 超 200 → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 'x'.repeat(201),
        description: 'd',
        preferredAgentId: 'dev-1',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/1-200/);
  });

  it('description 全空白 → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 't',
        description: '   ',
        preferredAgentId: 'dev-1',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/1-16000/);
  });

  it('description 超 16000 → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 't',
        description: 'x'.repeat(16001),
        preferredAgentId: 'dev-1',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/1-16000/);
  });

  it('preferredAgentId 空字符串 → 201（等价于稍后分配）', async () => {
    vi.spyOn(app.ctx.agentManager, 'createAndStartTask').mockResolvedValue(
      makeTask({ id: 'task-empty', preferredAgentId: '', agentId: '', status: 'pending', branch: '' }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 't',
        description: 'd',
        preferredAgentId: '',
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it('projectId 全 whitespace → 400（不让 404 Project not found 误导）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: '   ',
        title: 't',
        description: 'd',
        preferredAgentId: 'dev-1',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/projectId is required/);
  });

  it('projectId 前后 whitespace → trim 后 lookup', async () => {
    const createSpy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask').mockResolvedValue(
      makeTask({ id: 'task-y', projectId: 'proj', status: 'pending', branch: '' }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: '  proj  ',
        title: 't',
        description: 'd',
        preferredAgentId: 'dev-1',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(createSpy).toHaveBeenCalledWith('proj', expect.anything(), { background: true });
  });

  it('title 含换行 → 400（H1 markdown 必须 single-line）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 'line1\nline2',
        description: 'd',
        preferredAgentId: 'dev-1',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/single line/);
  });

  it('preferredAgentId 全 whitespace → 201（trim 后等价于空，走 unassigned 路径）', async () => {
    vi.spyOn(app.ctx.agentManager, 'createAndStartTask').mockResolvedValue(
      makeTask({ id: 'task-ws', preferredAgentId: '', agentId: '', status: 'pending', branch: '' }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 't',
        description: 'd',
        preferredAgentId: '   ',
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it('preferredAgentId 前后 whitespace → trim 后传给 manager', async () => {
    const createSpy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask').mockResolvedValue(
      makeTask({ id: 'task-x', preferredAgentId: 'dev-1', status: 'pending', branch: '' }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 't',
        description: 'd',
        preferredAgentId: '  dev-1  ',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(createSpy).toHaveBeenCalledWith('proj', expect.objectContaining({
      preferredAgentId: 'dev-1', // trimmed
    }), { background: true });
  });

  it('preferredAgentId 不存在的 agent → 400（manager 抛 ApiError 透传）', async () => {
    vi.spyOn(app.ctx.agentManager, 'createAndStartTask')
      .mockRejectedValue(new ApiError(400, 'Unknown agent: nope'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 't',
        description: 'd',
        preferredAgentId: 'nope',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/Unknown agent/);
  });

  it('preferredAgentId provided but number → 400 (do not silently coerce to unassigned)', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'createAndStartTask');
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { projectId: 'proj', title: 't', description: 'd', preferredAgentId: 42 },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/preferredAgentId must be a string/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('preferredAgentId provided but null → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { projectId: 'proj', title: 't', description: 'd', preferredAgentId: null },
    });
    expect(response.statusCode).toBe(400);
  });

  it('preferredAgentId provided but object → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { projectId: 'proj', title: 't', description: 'd', preferredAgentId: { id: 'x' } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/tasks/:id/retry', () => {
  it('terminal task → 201 with fresh task body; manager.retryTask invoked with the original id', async () => {
    const fresh = makeTask({ id: 'task-fresh', status: 'in_progress' });
    const spy = vi.spyOn(app.ctx.agentManager, 'retryTask').mockResolvedValue(fresh);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-001/retry',
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.id).toBe('task-fresh');
    expect(spy).toHaveBeenCalledWith('task-001');
  });

  it('non-terminal task → 409 (ApiError pass-through from manager.retryTask)', async () => {
    vi.spyOn(app.ctx.agentManager, 'retryTask')
      .mockRejectedValue(new ApiError(409, 'Task task-001 cannot be retried in status "in_progress"'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-001/retry',
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/cannot be retried/);
  });

  it('unknown task → 404', async () => {
    vi.spyOn(app.ctx.agentManager, 'retryTask')
      .mockRejectedValue(new ApiError(404, 'Task not found'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-missing/retry',
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/tasks/:id/complete', () => {
  it('202 with updated task; manager.markTaskComplete invoked with the id', async () => {
    const updated = makeTask({ id: 'task-001', status: 'merged' });
    const spy = vi.spyOn(app.ctx.agentManager, 'markTaskComplete').mockResolvedValue(updated);

    const response = await app.inject({ method: 'POST', url: '/api/tasks/task-001/complete' });

    expect(response.statusCode).toBe(202);
    expect(spy).toHaveBeenCalledWith('task-001');
  });

  it('merge failure → 409 pass-through', async () => {
    vi.spyOn(app.ctx.agentManager, 'markTaskComplete')
      .mockRejectedValue(new ApiError(409, 'Merge failed for task task-001: not approved'));

    const response = await app.inject({ method: 'POST', url: '/api/tasks/task-001/complete' });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/Merge failed/);
  });
});

describe('POST /api/tasks/:id/continue', () => {
  it('202 with updated task; manager.continueDevRound invoked with the id', async () => {
    const updated = makeTask({ id: 'task-001', status: 'fixing', reviewRound: 3 });
    const spy = vi.spyOn(app.ctx.agentManager, 'continueDevRound').mockResolvedValue(updated);

    const response = await app.inject({ method: 'POST', url: '/api/tasks/task-001/continue' });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body).reviewRound).toBe(3);
    expect(spy).toHaveBeenCalledWith('task-001');
  });

  it('non-max_rounds task → 409 pass-through', async () => {
    vi.spyOn(app.ctx.agentManager, 'continueDevRound')
      .mockRejectedValue(new ApiError(409, 'Task task-001 is not at max_rounds (status=review)'));

    const response = await app.inject({ method: 'POST', url: '/api/tasks/task-001/continue' });

    expect(response.statusCode).toBe(409);
  });
});

describe('POST /api/tasks/:id/dispatch', () => {
  beforeEach(async () => {
    await app.ctx.taskStore.set(makeTask({
      id: 'task-pending',
      status: 'pending',
      preferredAgentId: 'dev-1',
      agentId: '',
    }));
    await app.ctx.taskStore.set(makeTask({
      id: 'task-unassigned',
      status: 'pending',
      preferredAgentId: '',
      agentId: '',
    }));
  });

  it('200: pending task + agentId in body → dispatch ok', async () => {
    const dispatched = makeTask({ id: 'task-pending', status: 'in_progress', agentId: 'dev-1' });
    vi.spyOn(app.ctx.agentManager, 'dispatchPendingTask').mockResolvedValue({ task: dispatched });

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-pending/dispatch',
      payload: { agentId: 'dev-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).id).toBe('task-pending');
  });

  it('200: agentId omitted → dispatchPendingTask receives undefined and resolves fallback inside its own lock (race-free)', async () => {
    const dispatched = makeTask({ id: 'task-pending', status: 'in_progress', agentId: 'dev-1' });
    const spy = vi.spyOn(app.ctx.agentManager, 'dispatchPendingTask').mockResolvedValue({ task: dispatched });

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-pending/dispatch',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith('task-pending', undefined);
  });

  it('400: dispatchPendingTask returns 400 when task is unassigned and no agentId provided', async () => {
    vi.spyOn(app.ctx.agentManager, 'dispatchPendingTask').mockResolvedValue({
      task: null,
      errorCode: 400,
      error: 'Task task-unassigned has no preferredAgentId; agentId is required in request body',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-unassigned/dispatch',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/agentId is required/);
  });

  it('400: request body is a JSON primitive (number) → reject before manager call', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'dispatchPendingTask');
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-pending/dispatch',
      payload: 123 as unknown,
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/JSON object/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('400: request body is an array → reject', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-pending/dispatch',
      payload: ['dev-1'] as unknown,
    });
    expect(response.statusCode).toBe(400);
  });

  it('400: request body is explicitly null → reject (not coerced to {})', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'dispatchPendingTask');
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-pending/dispatch',
      payload: 'null',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/JSON object/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('400: dispatchPendingTask returns errorCode=400', async () => {
    vi.spyOn(app.ctx.agentManager, 'dispatchPendingTask').mockResolvedValue({
      task: null, errorCode: 400, error: 'Unknown agent: ghost',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-pending/dispatch',
      payload: { agentId: 'ghost' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('404: task does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-missing/dispatch',
      payload: { agentId: 'dev-1' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('409: dispatchPendingTask returns errorCode=409', async () => {
    vi.spyOn(app.ctx.agentManager, 'dispatchPendingTask').mockResolvedValue({
      task: null, errorCode: 409, error: 'Agent dev-1 is busy or awaiting human',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-pending/dispatch',
      payload: { agentId: 'dev-1' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('400: agentId provided but not a string (number) → reject before manager call', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'dispatchPendingTask');
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-pending/dispatch',
      payload: { agentId: 123 },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/agentId must be a string/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('400: agentId provided but null → reject', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-pending/dispatch',
      payload: { agentId: null },
    });
    expect(response.statusCode).toBe(400);
  });

  it('400: agentId provided but object → reject', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-pending/dispatch',
      payload: { agentId: { id: 'dev-1' } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('PATCH /api/tasks/:id', () => {
  it('改 title → 200 + editTask 收到 trimmed patch', async () => {
    const updated = makeTask({ status: 'pending', title: 'new title' });
    const spy = vi.spyOn(app.ctx.agentManager, 'editTask').mockResolvedValue(updated);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { title: '  new title  ' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.title).toBe('new title');
    expect(spy).toHaveBeenCalledWith('task-001', { title: 'new title' });
  });

  it('改 description → 200 + editTask 收到 trimmed', async () => {
    const updated = makeTask({ status: 'pending', description: 'new desc' });
    const spy = vi.spyOn(app.ctx.agentManager, 'editTask').mockResolvedValue(updated);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { description: '  new desc  ' },
    });

    expect(response.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith('task-001', { description: 'new desc' });
  });

  it('改 preferredAgentId 立即重派 → 响应反映 manager refresh 后 in_progress + 新 dev', async () => {
    const refreshed = makeTask({
      status: 'in_progress',
      preferredAgentId: 'dev-2',
      agentId: 'dev-2',
    });
    const spy = vi.spyOn(app.ctx.agentManager, 'editTask').mockResolvedValue(refreshed);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { preferredAgentId: 'dev-2' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.status).toBe('in_progress');
    expect(body.agentId).toBe('dev-2');
    expect(spy).toHaveBeenCalledWith('task-001', { preferredAgentId: 'dev-2' });
  });

  it('title 全空白 → 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { title: '   ' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/1-200/);
  });

  it('title 超 200 → 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { title: 'x'.repeat(201) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('description 全空白 → 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { description: '   ' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/1-16000/);
  });

  it('preferredAgentId 空字符串 → 200（清空当前分配）', async () => {
    const cleared = makeTask({ id: 'task-001', preferredAgentId: '', qaAgentId: undefined });
    vi.spyOn(app.ctx.agentManager, 'editTask').mockResolvedValue(cleared);
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { preferredAgentId: '' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('preferredAgentId provided but number → 400 (do not coerce to empty/clear)', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'editTask');
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { preferredAgentId: 123 },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/preferredAgentId must be a string/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('preferredAgentId provided but null → 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { preferredAgentId: null },
    });
    expect(response.statusCode).toBe(400);
  });

  it('in_progress 改 title → 409（editTask 抛 ApiError 透传）', async () => {
    vi.spyOn(app.ctx.agentManager, 'editTask')
      .mockRejectedValue(new ApiError(409, 'Task not editable in status in_progress'));

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { title: 'new' },
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/not editable/);
  });

  it("body { status: 'cancelled' } → 200 + cancelTask 被调", async () => {
    const cancelled = makeTask({ status: 'cancelled' });
    const spy = vi.spyOn(app.ctx.agentManager, 'cancelTask').mockResolvedValue(cancelled);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { status: 'cancelled' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.status).toBe('cancelled');
    expect(spy).toHaveBeenCalledWith('task-001');
  });

  it('cancelled 后 PR 字段保留不变（来自 manager 的响应）', async () => {
    const cancelled = makeTask({
      status: 'cancelled',
      prNumber: 42,
      prUrl: 'https://example.com/pr/42',
    });
    vi.spyOn(app.ctx.agentManager, 'cancelTask').mockResolvedValue(cancelled);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { status: 'cancelled' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as TaskState;
    expect(body.prNumber).toBe(42);
    expect(body.prUrl).toBe('https://example.com/pr/42');
  });

  it("body { status: 'cancelled' } 但 task 已 merged → 409（cancelTask 抛 ApiError）", async () => {
    vi.spyOn(app.ctx.agentManager, 'cancelTask')
      .mockRejectedValue(new ApiError(409, 'Cannot cancel task in status merged'));

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { status: 'cancelled' },
    });
    expect(response.statusCode).toBe(409);
  });

  it("body { status: 'failed' } → 400 only cancelled accepted", async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { status: 'failed' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/Only 'cancelled'/);
  });

  it("同时 title + status='cancelled' → 400 不能合并", async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: { title: 't', status: 'cancelled' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/Cannot combine cancellation with edits/);
  });

  it('全空 body → 400 no fields to update', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-001',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/no fields to update/);
  });

  it('未知 task → 404（manager 抛 ApiError 透传）', async () => {
    vi.spyOn(app.ctx.agentManager, 'editTask')
      .mockRejectedValue(new ApiError(404, 'Task not found'));

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/no-such',
      payload: { title: 't' },
    });
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

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 'should be queued',
        description: 'agent is still being created, but queue is allowed now',
        preferredAgentId: 'dev-1',
      },
    });

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

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 'should be queued',
        description: 'agent is bound to another task',
        preferredAgentId: 'dev-1',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('pending');
    expect(body.agentId).toBe('');
  });

  it('previewPromptBytesForTaskInput returns over-limit → 400', async () => {
    vi.spyOn(app.ctx.agentManager, 'previewPromptBytesForTaskInput')
      .mockReturnValue(100 * 1024); // > MAX_PROMPT_BYTES_ROUTE_LIMIT (79KB)

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 'tiny title',
        description: 'tiny body',
        preferredAgentId: 'dev-1',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/exceeds.*limit/);
    expect(body.error).toMatch(/AGENT_PHASES/);
  });

  it('previewPromptBytesForTaskInput throws (unknown agent) → 400', async () => {
    vi.spyOn(app.ctx.agentManager, 'previewPromptBytesForTaskInput')
      .mockImplementation(() => { throw new Error('Unknown agent: ghost'); });

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'proj',
        title: 't',
        description: 'd',
        preferredAgentId: 'ghost',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/Unknown agent/);
  });
});

describe('server review mode API', () => {
  it('GET /api/tasks/:id/reviews returns [] when no rounds exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tasks/task-x/reviews' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  it('GET /api/tasks/:id/reviews returns stored rounds across phases', async () => {
    const store = app.ctx.agentManager.getReviewStore()!;
    await store.putRound('task-r', 'spec', {
      round: 1, phase: 'spec', content: 'S', startedAt: 'now',
    });
    await store.putRound('task-r', 'code', {
      round: 1, phase: 'code', content: 'C', startedAt: 'now',
      findings: { round: 1, verdict: 'approve', findings: [] },
    });
    const response = await app.inject({ method: 'GET', url: '/api/tasks/task-r/reviews' });
    const rounds = JSON.parse(response.body) as Array<{ phase: string; round: number }>;
    expect(rounds.map(r => `${r.phase}-${r.round}`)).toEqual(['spec-1', 'code-1']);
  });

  it('POST /api/tasks/:id/complete confirms a ready task to done', async () => {
    await app.ctx.taskStore.set(makeTask({
      id: 'task-ready', status: 'ready', reviewMode: 'server', branch: 'bx/task-ready',
    }));
    const response = await app.inject({ method: 'POST', url: '/api/tasks/task-ready/complete' });
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body).status).toBe('done');
  });

  it('PATCH cancel works from ready', async () => {
    await app.ctx.taskStore.set(makeTask({
      id: 'task-ready2', status: 'ready', reviewMode: 'server', branch: 'bx/task-ready2',
    }));
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/task-ready2',
      payload: { status: 'cancelled' },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).status).toBe('cancelled');
  });
});
