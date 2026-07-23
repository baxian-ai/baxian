import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentBindingFacts, AgentSnapshot } from '../../src/shared/index.js';
import * as imageInput from '../../src/agent/image-input.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import { requesters, setupApiHarness, teardownApiHarness, type ApiHarness } from './helpers.js';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');

let harness: ApiHarness;
let app: FastifyInstance;
const { get, post, del } = requesters(() => app);

function setAgent(facts: Partial<AgentBindingFacts> & { id: string }): Promise<void> {
  return app.ctx.agentStore.set({ projectId: 'proj', updatedAt: new Date().toISOString(), ...facts });
}

beforeEach(async () => {
  harness = await setupApiHarness('agents');
  app = harness.app;
});

afterEach(() => teardownApiHarness(harness));

describe('GET /api/agents', () => {
  it('returns configured agents with unknown runtime status initially', async () => {
    const response = await get('/api/agents');
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
    await setAgent({ id: 'dev-1' });
    app.ctx.tmuxSessionStatusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      observedAt: '2026-05-01T00:00:00.000Z',
    });

    const response = await get('/api/agents');
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
    const response = await get('/api/agents/dev-1');
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
    await setAgent({ id: 'dev-1', taskId: 'task-001' });
    app.ctx.tmuxSessionStatusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      observedAt: '2026-05-01T00:00:00.000Z',
    });

    const response = await get('/api/agents/dev-1');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AgentSnapshot;
    expect(body.id).toBe('dev-1');
    expect(body.runtimeStatus).toBe('working');
    expect(body.binding?.taskId).toBe('task-001');
    expect(body.tmuxSessionStatus).toBe('present');
  });

  it('returns 404 for unknown agent', async () => {
    const response = await get('/api/agents/no-such-agent');
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/agents/:id/images', () => {
  it('writes the image to the agent host and returns its path', async () => {
    await setAgent({ id: 'dev-1', paneId: '%1' });
    const REF = { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' };
    const snapshotSpy = vi.spyOn(TmuxManager.prototype, 'getSessionSnapshot')
      .mockResolvedValue({ ref: REF, claim: 'dev-1' });
    const paneSpy = vi.spyOn(TmuxManager.prototype, 'getSinglePaneByRef')
      .mockResolvedValue({ session: REF, paneId: '%1', claim: 'dev-1' });
    try {
      const res = await post('/api/agents/dev-1/images', { dataBase64: PNG_B64 });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).path).toMatch(/^\/tmp\/baxian\/upload\/dev-1\/[0-9a-f-]+\.png$/);
    } finally {
      snapshotSpy.mockRestore();
      paneSpy.mockRestore();
    }
  });

  it('400 for a non-image payload', async () => {
    await setAgent({ id: 'dev-1', paneId: '%1' });
    const res = await post('/api/agents/dev-1/images', {
      dataBase64: Buffer.from('not an image').toString('base64'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('404 for an unknown agent', async () => {
    const res = await post('/api/agents/nope/images', { dataBase64: PNG_B64 });
    expect(res.statusCode).toBe(404);
  });

  it('409 when the agent has no live session (no paneId)', async () => {
    await setAgent({ id: 'dev-1' });
    const res = await post('/api/agents/dev-1/images', { dataBase64: PNG_B64 });
    expect(res.statusCode).toBe(409);
  });

  it('400 when dataBase64 is missing, empty, or not a string', async () => {
    await setAgent({ id: 'dev-1', paneId: '%1' });
    for (const payload of [{}, { dataBase64: '' }, { dataBase64: 123 }]) {
      const res = await post('/api/agents/dev-1/images', payload);
      expect.soft(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect.soft(JSON.parse(res.body).error, JSON.stringify(payload)).toMatch(/dataBase64/);
    }
  });

  it('non-validation decode failure propagates as 500 (not masked as a 400)', async () => {
    await setAgent({ id: 'dev-1', paneId: '%1' });
    const spy = vi.spyOn(imageInput, 'decodeBase64Image').mockImplementation(() => {
      throw new Error('tmpdir unwritable');
    });
    try {
      const res = await post('/api/agents/dev-1/images', { dataBase64: PNG_B64 });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe('internal_error');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('POST /api/agents/:id/compact', () => {
  it('delegates to compactAgent and returns 200', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'compactAgent').mockResolvedValue(undefined);
    const res = await post('/api/agents/dev-1/compact');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ compacted: true });
    expect(spy).toHaveBeenCalledWith('dev-1');
    spy.mockRestore();
  });

  it('returns 404 for an unknown agent', async () => {
    const res = await post('/api/agents/nope/compact');
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when the agent has no live session', async () => {
    await setAgent({ id: 'dev-1' });
    const res = await post('/api/agents/dev-1/compact');
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/agents/:id/clear', () => {
  it('delegates to clearAgent and returns 200', async () => {
    const spy = vi.spyOn(app.ctx.agentManager, 'clearAgent').mockResolvedValue(undefined);
    const res = await post('/api/agents/dev-1/clear');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ cleared: true });
    expect(spy).toHaveBeenCalledWith('dev-1');
    spy.mockRestore();
  });

  it('returns 404 for an unknown agent', async () => {
    const res = await post('/api/agents/nope/clear');
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when the agent has no live session', async () => {
    await setAgent({ id: 'dev-1' });
    const res = await post('/api/agents/dev-1/clear');
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
      devAgentId: 'dev-1',
      phase: 'code',
      reviewMode: 'server',
      reviewRound: 0,
      status: 'in_progress',
      branch: 'bx/task-001',
      createdAt: now,
      updatedAt: now,
    });
    await setAgent({ id: 'dev-1', taskId: 'task-001' });

    const response = await del('/api/agents/dev-1/session');
    expect(response.statusCode).toBe(204);

    const task = await app.ctx.taskStore.get('task-001');
    expect(task?.status).toBe('cancelled');
  });

  it('with no active task → returns 204 (no-op)', async () => {
    await setAgent({ id: 'dev-1' });
    const response = await del('/api/agents/dev-1/session');
    expect(response.statusCode).toBe(204);
  });

  it('cancelTask failure is logged and swallowed → still 204', async () => {
    await setAgent({ id: 'dev-1', taskId: 'task-broken' });
    const spy = vi.spyOn(app.ctx.agentManager, 'cancelTask').mockRejectedValue(new Error('tmux gone'));
    try {
      const response = await del('/api/agents/dev-1/session');
      expect(response.statusCode).toBe(204);
      expect(spy).toHaveBeenCalledWith('task-broken');
    } finally {
      spy.mockRestore();
    }
  });
});
