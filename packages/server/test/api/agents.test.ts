import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { AgentBindingFacts, AgentSnapshot } from '../../src/shared/index.js';
import { buildApp } from '../../src/app.js';
import { createTestContext } from '../helpers/context.js';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');

let tempDir: string;
let app: FastifyInstance;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-agents-test-'));
  const ctx = await createTestContext(tempDir);
  app = await buildApp(ctx);
});

afterEach(async () => {
  await app.close();
  await rm(tempDir, { recursive: true });
});

describe('GET /api/agents', () => {
  it('returns configured agents with unknown runtime status initially', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([
      {
        id: 'dev-1',
        projectId: 'proj',
        runtimeStatus: 'unknown',
        tmuxSessionStatus: 'unknown',
        stale: true,
      },
      {
        id: 'qa-1',
        projectId: 'proj',
        runtimeStatus: 'unknown',
        tmuxSessionStatus: 'unknown',
        stale: true,
      },
    ]);
  });

  it('merges configured agents, binding facts, and tmux probe status', async () => {
    const state: AgentBindingFacts = {
      id: 'dev-1',
      projectId: 'proj',
      updatedAt: new Date().toISOString(),
    };
    await app.ctx.agentStore.set(state);
    app.ctx.tmuxSessionStatusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      observedAt: '2026-05-01T00:00:00.000Z',
    });

    const response = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AgentSnapshot[];
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe('dev-1');
    expect(body[0].runtimeStatus).toBe('idle');
    expect(body[0].tmuxSessionStatus).toBe('present');
    expect(body[0].observedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(body[0].binding).toMatchObject({ id: 'dev-1', projectId: 'proj' });
    expect(body[1]).toMatchObject({
      id: 'qa-1',
      runtimeStatus: 'unknown',
      tmuxSessionStatus: 'unknown',
    });
  });
});

describe('GET /api/agents/:id', () => {
  it('returns configured agent details before state exists', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/agents/dev-1' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AgentSnapshot;
    expect(body).toMatchObject({
      id: 'dev-1',
      projectId: 'proj',
      runtimeStatus: 'unknown',
      tmuxSessionStatus: 'unknown',
      stale: true,
    });
  });

  it('returns agent details for known agent', async () => {
    const state: AgentBindingFacts = {
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-001',
      updatedAt: new Date().toISOString(),
    };
    await app.ctx.agentStore.set(state);
    app.ctx.tmuxSessionStatusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      observedAt: '2026-05-01T00:00:00.000Z',
    });

    const response = await app.inject({ method: 'GET', url: '/api/agents/dev-1' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AgentSnapshot;
    expect(body.id).toBe('dev-1');
    expect(body.runtimeStatus).toBe('working');
    expect(body.binding?.taskId).toBe('task-001');
    expect(body.tmuxSessionStatus).toBe('present');
  });

  it('returns 404 for unknown agent', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/agents/no-such-agent' });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/agents/:id/images', () => {
  it('writes the image to the agent host and returns its path', async () => {
    await app.ctx.agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%1', updatedAt: new Date().toISOString() });
    const res = await app.inject({
      method: 'POST', url: '/api/agents/dev-1/images', payload: { dataBase64: PNG_B64 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).path).toMatch(/^\/tmp\/baxian\/upload\/dev-1\/[0-9a-f-]+\.png$/);
  });

  it('400 for a non-image payload', async () => {
    await app.ctx.agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%1', updatedAt: new Date().toISOString() });
    const res = await app.inject({
      method: 'POST', url: '/api/agents/dev-1/images',
      payload: { dataBase64: Buffer.from('not an image').toString('base64') },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404 for an unknown agent', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/agents/nope/images', payload: { dataBase64: PNG_B64 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('409 when the agent has no live session (no paneId)', async () => {
    await app.ctx.agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString() });
    const res = await app.inject({
      method: 'POST', url: '/api/agents/dev-1/images', payload: { dataBase64: PNG_B64 },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/agents/:id/clear', () => {
  it('delegates to clearAgent and returns 200', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'clearAgent').mockResolvedValue(undefined);
    const res = await app.inject({ method: 'POST', url: '/api/agents/dev-1/clear' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ cleared: true });
    expect(spy).toHaveBeenCalledWith('dev-1');
    spy.mockRestore();
  });

  it('returns 404 for an unknown agent', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agents/nope/clear' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when the agent has no live session', async () => {
    await app.ctx.agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString() });
    const res = await app.inject({ method: 'POST', url: '/api/agents/dev-1/clear' });
    expect(res.statusCode).toBe(409);
  });
});

describe('DELETE /api/agents/:id/session', () => {
  it('with active task → cancels the task (status=cancelled) + returns 204', async () => {
    const now = new Date().toISOString();
    await app.ctx.taskStore.set({
      id: 'task-001',
      projectId: 'proj',
      title: 't',
      description: 'd',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      reviewRound: 0,
      status: 'in_progress',
      branch: 'bx/task-001',
      createdAt: now,
      updatedAt: now,
    });
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-001',
      updatedAt: now,
    });

    const response = await app.inject({ method: 'DELETE', url: '/api/agents/dev-1/session' });
    expect(response.statusCode).toBe(204);

    const task = await app.ctx.taskStore.get('task-001');
    expect(task?.status).toBe('cancelled');
  });

  it('with no active task → returns 204 (no-op)', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({ method: 'DELETE', url: '/api/agents/dev-1/session' });
    expect(response.statusCode).toBe(204);
  });
});
