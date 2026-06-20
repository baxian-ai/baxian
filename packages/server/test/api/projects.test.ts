import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { BaxianConfig } from '../../src/shared/index.js';
import { buildApp } from '../../src/app.js';
import { createTestContext } from '../helpers/context.js';

let tempDir: string;
let app: FastifyInstance;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-projects-test-'));
  const ctx = await createTestContext(tempDir);
  configPath = join(tempDir, 'baxian.json');
  await writeFile(configPath, JSON.stringify(ctx.config, null, 2));
  ctx.configPath = configPath;
  app = await buildApp(ctx);
  vi.spyOn(app.ctx.agentManager, 'ensureSession').mockResolvedValue({
    ok: true,
    createdSession: true,
    paneId: '%0',
    workdir: '/tmp/test',
  });
  vi.spyOn(app.ctx.agentManager, 'cleanupRemovedAgentRuntime').mockResolvedValue();

  const originalInject = app.inject.bind(app);
  app.inject = (async (...args: Parameters<typeof originalInject>) => {
    const response = await originalInject(...args);
    const opts = args[0] as { method?: string; url?: string } | undefined;
    if (
      response.statusCode === 201 &&
      opts?.method === 'POST' &&
      typeof opts.url === 'string' &&
      /\/api\/projects\/[^/]+\/agents$/.test(opts.url)
    ) {
      try {
        const body = JSON.parse(response.body) as { agent?: { id?: string } };
        const id = body?.agent?.id;
        if (id) await app.ctx.agentManager.waitForBootstrapSettled(id, 2_000);
      } catch {}
    }
    return response;
  }) as typeof app.inject;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  // maxRetries guards macOS APFS ENOTEMPTY from background fsync racing rm.
  await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('POST /api/projects', () => {
  it('creates a new project with empty agent array', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'newproj', repo: 'baxian-ai/baxian', merge: null },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.project.id).toBe('newproj');
    expect(body.project.agent).toEqual([]);
    expect(body.project.review?.mode).toBeUndefined();
    expect(body.restartRequired).toBe(false);
    expect(app.ctx.config.project.some(p => p.id === 'newproj')).toBe(true);
  });

  it('hot-reloads agentManager / tmuxProbePoller / bootstrapPoller / poller with the new config', async () => {
    const agentReplace = vi.spyOn(app.ctx.agentManager, 'replaceConfig');
    const tmuxReplace = vi.fn();
    const bootstrapReplace = vi.fn();
    const pollerReplace = vi.fn();
    app.ctx.tmuxProbePoller = { replaceConfig: tmuxReplace, stop: vi.fn() } as never;
    app.ctx.bootstrapPoller = { replaceConfig: bootstrapReplace, stop: vi.fn() } as never;
    app.ctx.poller = { replaceConfig: pollerReplace, stop: vi.fn() } as never;
    app.ctx.stateDir = tempDir;

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'hot', repo: 'a/b' },
    });
    expect(response.statusCode).toBe(201);

    expect(agentReplace).toHaveBeenCalledTimes(1);
    expect(agentReplace.mock.calls[0][0].project.some((p: { id: string }) => p.id === 'hot')).toBe(true);
    expect(tmuxReplace).toHaveBeenCalledTimes(1);
    expect(bootstrapReplace).toHaveBeenCalledTimes(1);
    expect(pollerReplace).toHaveBeenCalledTimes(1);
    const [validated, opts] = pollerReplace.mock.calls[0];
    expect(validated.project.some((p: { id: string }) => p.id === 'hot')).toBe(true);
    expect(typeof opts.statePathFor).toBe('function');
    const path = opts.statePathFor({ repo: 'A/B' });
    expect(path).toContain('poller-a%2Fb.json');
  });

  it('still hot-reloads when stateDir is unset (new poller entry created without statePath)', async () => {
    const pollerReplace = vi.fn();
    app.ctx.poller = { replaceConfig: pollerReplace, stop: vi.fn() } as never;
    app.ctx.stateDir = undefined;
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'nopath', repo: 'c/d' },
    });
    expect(res.statusCode).toBe(201);
    expect(pollerReplace.mock.calls[0][1].statePathFor).toBeUndefined();
  });

  it('defaults merge to null when omitted', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'p2', repo: 'a/b' },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.project.merge).toBeNull();
  });

  it('persists project review mode when provided', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'serverproj', repo: 'a/server', review: { mode: 'server' } },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.project.review).toEqual({ mode: 'server' });
    expect(app.ctx.config.project.find(p => p.id === 'serverproj')?.review?.mode).toBe('server');
  });

  it('rejects non-github projects that would fall back to github review mode', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'gitlabproj', repo: 'https://gitlab.example.com/group/proj.git' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('creates a non-github project with an explicit server review mode override', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'gitlabproj', repo: 'https://gitlab.example.com/group/proj.git', review: { mode: 'server' } },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.project.review).toEqual({ mode: 'server' });
  });

  it('returns 409 on duplicate project id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'proj', repo: 'a/b' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('returns 400 on invalid repo format', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'badrepo', repo: 'not-a-valid-repo' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('creates a project from a git URL repo and stores it verbatim', async () => {
    for (const [id, repo] of [
      ['urlhttps', 'https://github.com/example-owner/example-repo.git'],
      ['urlssh', 'git@github.com:example-owner/example-repo.git'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { id, repo, merge: null },
      });
      expect(response.statusCode).toBe(201);
      expect(JSON.parse(response.body).project.repo).toBe(repo);
    }
  });

  it('creates a project from a non-github git URL (stored verbatim, incl. subgroup paths)', async () => {
    for (const [id, repo] of [
      ['glproj', 'https://gitlab.example.com/group/proj.git'],
      ['glsub', 'https://gitlab.example.com/group/sub/proj.git'],
      ['glssh', 'git@gitlab.example.com:group/proj.git'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { id, repo, merge: null, review: { mode: 'server' } },
      });
      expect.soft(response.statusCode, repo).toBe(201);
      expect.soft(JSON.parse(response.body).project.repo, repo).toBe(repo);
    }
  });

  it('returns 400 on empty id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: '', repo: 'a/b' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('writes to baxian.json with backup', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'persisted', repo: 'a/b' },
    });
    const written = JSON.parse(await readFile(configPath, 'utf-8')) as BaxianConfig;
    const project = written.project.find(p => p.id === 'persisted');
    expect(project).toBeDefined();
    expect(project?.review?.mode).toBeUndefined();
    const files = await readdir(tempDir);
    expect(files.some(f => /^baxian\.json\.\d{8}-\d{6}$/.test(f))).toBe(true);
  });
});

describe('POST /api/projects/:projectId/agents', () => {
  it('appends a dev agent as a new pair', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'empty', repo: 'a/b' } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/empty/agents',
      payload: {
        id: 'new-dev',
        runtime: 'claude-code',
        role: 'dev',
        mode: 'local',
        yolo: true,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.agent.id).toBe('new-dev');
    expect(body.agent.yolo).toBe(true);

    const proj = app.ctx.config.project.find(p => p.id === 'empty')!;
    expect(proj.agent).toHaveLength(1);
    expect(proj.agent[0]).toHaveLength(1);
    expect(proj.agent[0][0].id).toBe('new-dev');
  });

  it('returns restartRequired:false — agent CRUD is hot-loaded via replaceConfig, no restart needed', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'rr1', repo: 'a/b' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/rr1/agents',
      payload: { id: 'rr1-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.restartRequired).toBe(false);
    expect(app.ctx.agentManager.getAgentConfig('rr1-dev')).toBeDefined();
    expect(await app.ctx.agentStore.get('rr1-dev')).not.toBeNull();
  });

  it('appends a qa agent to existing dev pair when pairWith provided', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'pp3', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/pp3/agents',
      payload: { id: 'pp3-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/pp3/agents',
      payload: {
        id: 'pp3-qa', runtime: 'codex', role: 'qa', mode: 'local', yolo: true,
        pairWith: 'pp3-dev',
      },
    });
    expect(response.statusCode).toBe(201);
    const proj = app.ctx.config.project.find(p => p.id === 'pp3')!;
    expect(proj.agent).toHaveLength(1);
    expect(proj.agent[0]).toHaveLength(2);
    expect(proj.agent[0][1].id).toBe('pp3-qa');
  });

  it('returns 404 when project does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/no-such/agents',
      payload: { id: 'xx', runtime: 'codex', role: 'dev', mode: 'local', yolo: true },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 409 when agent.id is taken globally', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'pp', repo: 'a/b' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/pp/agents',
      payload: { id: 'dev-1', runtime: 'codex', role: 'dev', mode: 'local', yolo: true },
    });
    expect(response.statusCode).toBe(409);
    expect(vi.mocked(app.ctx.agentManager.ensureSession)).not.toHaveBeenCalled();
  });

  it('returns 400 when role=qa but no pairWith provided', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'pq', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/pq/agents',
      payload: { id: 'pq-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/pq/agents',
      payload: { id: 'pq-qa', runtime: 'codex', role: 'qa', mode: 'local', yolo: true },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when pairWith refers to dev that already has a qa', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'pf', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/pf/agents',
      payload: { id: 'pf-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.inject({
      method: 'POST', url: '/api/projects/pf/agents',
      payload: { id: 'pf-qa1', runtime: 'codex', role: 'qa', mode: 'local', yolo: true, pairWith: 'pf-dev' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/pf/agents',
      payload: { id: 'pf-qa2', runtime: 'codex', role: 'qa', mode: 'local', yolo: true, pairWith: 'pf-dev' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when mode=remote but host missing', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'pr', repo: 'a/b' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/pr/agents',
      payload: { id: 'pr-dev', runtime: 'claude-code', role: 'dev', mode: 'remote', yolo: true },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when body is empty / role missing', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'pe', repo: 'a/b' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/pe/agents',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when role is not dev or qa', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'pi', repo: 'a/b' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/pi/agents',
      payload: { id: 'pi-x', runtime: 'codex', role: 'invalid', mode: 'local', yolo: true },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('DELETE /api/projects/:projectId/agents/:agentId', () => {
  it('removes orphan dev (sole member of pair) and returns it', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da1', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da1/agents',
      payload: { id: 'da1-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da1/agents/da1-dev',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.removed).toEqual(['da1-dev']);

    const proj = app.ctx.config.project.find(p => p.id === 'da1')!;
    expect(proj.agent).toEqual([]);
  });

  it('returns restartRequired:false on delete — symmetric with create', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'rrd', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/rrd/agents',
      payload: { id: 'rrd-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/rrd/agents/rrd-dev',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.restartRequired).toBe(false);
    expect(app.ctx.agentManager.getAgentConfig('rrd-dev')).toBeUndefined();
  });

  it('purges errorRecordStore entries for deleted agent (so a recreate with same id starts clean)', async () => {
    // The bootstrap snapshot field is keyed by agentId only — without this purge, deleting
    // an agent and recreating with the same id would inherit the old incarnation's red card.
    const purgeAgent = vi.fn().mockResolvedValue({ removed: 1 });
    app.ctx.errorRecordStore = { purgeAgent } as never;
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'purge1', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/purge1/agents',
      payload: { id: 'purge1-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.inject({ method: 'DELETE', url: '/api/projects/purge1/agents/purge1-dev' });
    expect(purgeAgent).toHaveBeenCalledWith('purge1-dev');
  });

  it('removes paired dev together with its qa', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da2', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da2/agents',
      payload: { id: 'da2-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.inject({
      method: 'POST', url: '/api/projects/da2/agents',
      payload: { id: 'da2-qa', runtime: 'codex', role: 'qa', mode: 'local', yolo: true, pairWith: 'da2-dev' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da2/agents/da2-dev',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.removed).toEqual(['da2-dev', 'da2-qa']);

    const proj = app.ctx.config.project.find(p => p.id === 'da2')!;
    expect(proj.agent).toEqual([]);
  });

  it('removes only the qa, leaving dev', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da3', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da3/agents',
      payload: { id: 'da3-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.inject({
      method: 'POST', url: '/api/projects/da3/agents',
      payload: { id: 'da3-qa', runtime: 'codex', role: 'qa', mode: 'local', yolo: true, pairWith: 'da3-dev' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da3/agents/da3-qa',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.removed).toEqual(['da3-qa']);

    const proj = app.ctx.config.project.find(p => p.id === 'da3')!;
    expect(proj.agent).toEqual([[expect.objectContaining({ id: 'da3-dev' })]]);
  });

  it('returns 409 when the agent is bound to an active task', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-busy', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-busy/agents',
      payload: { id: 'da-busy-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.ctx.agentStore.set({
      id: 'da-busy-dev',
      projectId: 'da-busy',
      taskId: 'task-da-busy',
      updatedAt: new Date().toISOString(),
    });
    await app.ctx.taskStore.set({
      id: 'task-da-busy',
      projectId: 'da-busy',
      title: 't',
      description: 'd',
      preferredAgentId: 'da-busy-dev',
      agentId: 'da-busy-dev',
      reviewRound: 0,
      status: 'in_progress',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-busy/agents/da-busy-dev',
    });
    expect(response.statusCode).toBe(409);

    const proj = app.ctx.config.project.find(p => p.id === 'da-busy')!;
    expect(proj.agent[0][0].id).toBe('da-busy-dev');
  });

  it('cascading dev delete is blocked if its paired qa is active', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-pair-busy', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-pair-busy/agents',
      payload: { id: 'da-pair-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.inject({
      method: 'POST', url: '/api/projects/da-pair-busy/agents',
      payload: {
        id: 'da-pair-qa', runtime: 'codex', role: 'qa', mode: 'local', yolo: true,
        pairWith: 'da-pair-dev',
      },
    });
    await app.ctx.agentStore.set({
      id: 'da-pair-qa',
      projectId: 'da-pair-busy',
      taskId: 'task-da-pair',
      updatedAt: new Date().toISOString(),
    });
    await app.ctx.taskStore.set({
      id: 'task-da-pair',
      projectId: 'da-pair-busy',
      title: 't',
      description: 'd',
      preferredAgentId: 'da-pair-dev',
      agentId: 'da-pair-dev',
      qaAgentId: 'da-pair-qa',
      reviewRound: 0,
      status: 'review',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-pair-busy/agents/da-pair-dev',
    });
    expect(response.statusCode).toBe(409);

    const proj = app.ctx.config.project.find(p => p.id === 'da-pair-busy')!;
    expect(proj.agent[0]).toHaveLength(2);
  });

  it('fresh-bootstrap dialog_pending agent can be DELETEd without waiting for slowPoll timeout', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-dialog', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-dialog/agents',
      payload: { id: 'da-dialog-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.ctx.agentStore.set({
      id: 'da-dialog-dev',
      projectId: 'da-dialog',
      paneId: '%0',
      updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-dialog/agents/da-dialog-dev',
    });
    expect(response.statusCode).toBe(200);
    const proj = app.ctx.config.project.find(p => p.id === 'da-dialog')!;
    expect(proj.agent).toEqual([]);
  });

  it('awaiting_human agent with creationToken set is DELETable (dialog_pending exit)', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-dialog-tok', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-dialog-tok/agents',
      payload: { id: 'da-dialog-tok-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    // dialog_pending：markDialogPending 设的 status='awaiting_human' + creationToken 仍持有。
    await app.ctx.agentStore.set({
      id: 'da-dialog-tok-dev',
      projectId: 'da-dialog-tok',
      creationToken: 'tok-pending',
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-dialog-tok/agents/da-dialog-tok-dev',
    });
    expect(response.statusCode).toBe(200);
    const proj = app.ctx.config.project.find(p => p.id === 'da-dialog-tok')!;
    expect(proj.agent).toEqual([]);
  });

  it('awaiting_human agent with NO paneId is still DELETable (getSinglePaneId 持续失败的退路)', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-boot', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-boot/agents',
      payload: { id: 'da-boot-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.ctx.agentStore.set({
      id: 'da-boot-dev',
      projectId: 'da-boot',
      creationToken: 'tok-bootstrapping',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-boot/agents/da-boot-dev',
    });
    expect(response.statusCode).toBe(200);
    const proj = app.ctx.config.project.find(p => p.id === 'da-boot')!;
    expect(proj.agent).toEqual([]);
  });

  it('concurrent DELETEs on the same awaiting_human agent: second request gets 409 (deletionInFlight claim)', async () => {
    // Without the claim, two cleanupRemovedAgentRuntime calls race on the same tmux/worktree via the stale-lock takeover path.
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-dup', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-dup/agents',
      payload: { id: 'da-dup-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.ctx.agentStore.set({
      id: 'da-dup-dev', projectId: 'da-dup',
      paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      updatedAt: new Date().toISOString(),
    });
    await app.ctx.lockManager.acquire('da-dup-dev');

    // 让 cleanupRemovedAgentRuntime 阻塞，使两个 DELETE phase2 必然重叠
    let resolveCleanup: () => void = () => undefined;
    const cleanupGate = new Promise<void>((resolve) => { resolveCleanup = resolve; });
    const cleanupSpy = vi.spyOn(app.ctx.agentManager, 'cleanupRemovedAgentRuntime')
      .mockImplementation(async () => { await cleanupGate; });

    const first = app.inject({ method: 'DELETE', url: '/api/projects/da-dup/agents/da-dup-dev' });
    // 让 first 进入 phase2（cleanupRemovedAgentRuntime 等 cleanupGate）
    await new Promise((r) => setTimeout(r, 20));
    const second = await app.inject({ method: 'DELETE', url: '/api/projects/da-dup/agents/da-dup-dev' });

    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error).toMatch(/deletion already in progress/);

    resolveCleanup();
    const firstResp = await first;
    expect(firstResp.statusCode).toBe(200);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('awaiting_human with stale lock: DELETE takes over (does not 409 on acquire failure)', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-stale', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-stale/agents',
      payload: { id: 'da-stale-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.ctx.agentStore.set({
      id: 'da-stale-dev', projectId: 'da-stale',
      paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      updatedAt: new Date().toISOString(),
    });
    // 模拟 awaiting_human 状态：前任 op 留下 stale lock 没 release
    await app.ctx.lockManager.acquire('da-stale-dev');

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-stale/agents/da-stale-dev',
    });
    expect(response.statusCode).toBe(200);
    // phase 3 应已清掉 stale lock
    expect(await app.ctx.lockManager.isLocked('da-stale-dev')).toBe(false);
  });

  it('awaiting_human + active task is REFUSED (cannot leave orphan task)', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-aw-active', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-aw-active/agents',
      payload: { id: 'da-aw-active-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.ctx.taskStore.set({
      id: 'task-orphan-risk', projectId: 'da-aw-active',
      title: 't', description: 'd', preferredAgentId: 'da-aw-active-dev',
      agentId: 'da-aw-active-dev', reviewRound: 0, status: 'in_progress',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await app.ctx.agentStore.set({
      id: 'da-aw-active-dev', projectId: 'da-aw-active',
      taskId: 'task-orphan-risk', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending',
      updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-aw-active/agents/da-aw-active-dev',
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/cancel the task before deleting/);
  });

  it('dev reserved by a max_rounds task is REFUSED (max_rounds is active; deleting would orphan it)', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-mr-active', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-mr-active/agents',
      payload: { id: 'da-mr-active-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.ctx.taskStore.set({
      id: 'task-mr-reserved', projectId: 'da-mr-active',
      title: 't', description: 'd', preferredAgentId: 'da-mr-active-dev',
      agentId: 'da-mr-active-dev', reviewRound: 10, status: 'max_rounds',
      prNumber: 7, branch: 'bx/task-mr-reserved',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await app.ctx.agentStore.set({
      id: 'da-mr-active-dev', projectId: 'da-mr-active',
      taskId: 'task-mr-reserved', paneId: '%0', status: 'waiting',
      worktreePath: '/tmp/wt', updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-mr-active/agents/da-mr-active-dev',
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/cancel the task before deleting/);
  });

  it('refuses deleting an UNBOUND agent still referenced by an active task (spec max_rounds preferredAgentId)', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-mr-ref', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-mr-ref/agents',
      payload: { id: 'da-mr-ref-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    // spec-phase max_rounds: dev released (agentId cleared) but preferredAgentId kept for Retry.
    await app.ctx.taskStore.set({
      id: 'task-spec-mr-ref', projectId: 'da-mr-ref',
      title: 't', description: 'd', preferredAgentId: 'da-mr-ref-dev',
      agentId: '', reviewRound: 5, status: 'max_rounds', phase: 'spec',
      prNumber: 8, branch: 'bx/task-spec-mr-ref',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // agent is idle/unbound (no taskId) — the binding-based guard alone would allow deletion.
    await app.ctx.agentStore.set({
      id: 'da-mr-ref-dev', projectId: 'da-mr-ref', status: 'idle', paneId: '%0',
      updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-mr-ref/agents/da-mr-ref-dev',
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/referenced by active task/);
  });

  it('bootstrap-in-progress (creationToken set, status ok) returns 409', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-boot-progress', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-boot-progress/agents',
      payload: { id: 'da-boot-progress-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.ctx.agentStore.set({
      id: 'da-boot-progress-dev',
      projectId: 'da-boot-progress',
      creationToken: 'tok-active-bootstrap',
      updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-boot-progress/agents/da-boot-progress-dev',
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/bootstrapping/);
  });

  it('terminal-status agents (idle/done/failed) can still be deleted', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-idle', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-idle/agents',
      payload: { id: 'da-idle-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.ctx.agentStore.set({
      id: 'da-idle-dev',
      projectId: 'da-idle',
      updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-idle/agents/da-idle-dev',
    });
    expect(response.statusCode).toBe(200);
  });

  it('preserves other pairs when deleting from a multi-pair project', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da4', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da4/agents',
      payload: { id: 'da4-dev1', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.inject({
      method: 'POST', url: '/api/projects/da4/agents',
      payload: { id: 'da4-dev2', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.inject({
      method: 'POST', url: '/api/projects/da4/agents',
      payload: { id: 'da4-dev3', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da4/agents/da4-dev2',
    });
    expect(response.statusCode).toBe(200);

    const proj = app.ctx.config.project.find(p => p.id === 'da4')!;
    expect(proj.agent).toHaveLength(2);
    expect(proj.agent[0][0].id).toBe('da4-dev1');
    expect(proj.agent[1][0].id).toBe('da4-dev3');
  });

  it('returns 404 for unknown agent', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/proj/agents/no-such',
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for unknown project', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/no-such/agents/dev-1',
    });
    expect(response.statusCode).toBe(404);
  });

  it('Phase 3 saveConfig fails → 500 + rollbackPerTargetState + lock released', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'da-rb', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/da-rb/agents',
      payload: { id: 'da-rb-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });
    await app.ctx.agentStore.set({
      id: 'da-rb-dev',
      projectId: 'da-rb',
      paneId: '%0',
      repoPath: '/tmp/repo',
      updatedAt: new Date().toISOString(),
    });

    const { saveConfig: realSaveConfig } = await import('../../src/config/loader.js');
    const loader = await import('../../src/config/loader.js');
    let phase3Hit = false;
    vi.spyOn(loader, 'saveConfig').mockImplementation(async (path, config) => {
      const proj = config.project.find(p => p.id === 'da-rb');
      if (proj && !proj.agent.flat().some(a => a.id === 'da-rb-dev')) {
        phase3Hit = true;
        throw new Error('disk full simulation');
      }
      return realSaveConfig(path, config);
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/projects/da-rb/agents/da-rb-dev',
    });

    expect(response.statusCode).toBe(500);
    expect(phase3Hit).toBe(true);
    expect(JSON.parse(response.body).error).toMatch(/failed to persist config/);

    const stateAfter = await app.ctx.agentStore.get('da-rb-dev');
    expect(stateAfter?.worktreePath).toBeUndefined();
    expect(stateAfter?.paneId).toBeUndefined();
    expect(stateAfter?.repoPath).toBe('/tmp/repo');

    expect(await app.ctx.lockManager.isLocked('da-rb-dev')).toBe(false);
  });
});

describe('POST /api/projects/:projectId/agents/:agentId/resume', () => {
  it('awaiting_human agent: resumeAgent invoked + 200', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1', projectId: 'proj',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      updatedAt: new Date().toISOString(),
    });
    const resumeSpy = vi.spyOn(app.ctx.agentManager, 'resumeAgent')
      .mockResolvedValue({ resumed: true, releasedBinding: true });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/resume',
    });

    expect(response.statusCode).toBe(200);
    expect(resumeSpy).toHaveBeenCalledWith('dev-1');
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({ agentId: 'dev-1', resumed: true, releasedBinding: true });
  });

  it('resume returns 409 when manager reports resumed=false (e.g. creationToken still set)', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1', projectId: 'proj',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending',
      creationToken: 'tok-pending',
      updatedAt: new Date().toISOString(),
    });
    vi.spyOn(app.ctx.agentManager, 'resumeAgent')
      .mockResolvedValue({ resumed: false, releasedBinding: false });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/resume',
    });

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/Bootstrap dialog still unresolved/);
    expect(body.resumed).toBe(false);
  });

  it('agent not awaiting_human: 409', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/resume',
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/not awaiting human/);
  });

  it('unknown agent: 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/no-such/resume',
    });
    expect(response.statusCode).toBe(404);
  });

  it('resume during DELETE cleanup (deletionInFlight): 409 (no resumeAgent invocation, prevents race with phase2 cleanup)', async () => {
    // DELETE phase2 runs without withConfigLock; Resume must check deletionInFlight or it dispatches into a tmux/worktree being torn down.
    await app.ctx.agentStore.set({
      id: 'dev-1', projectId: 'proj',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      updatedAt: new Date().toISOString(),
    });
    // 模拟 DELETE phase1 已 claim deletion，phase2 cleanup 中
    app.ctx.agentManager.tryClaimDeletion(['dev-1']);
    const resumeSpy = vi.spyOn(app.ctx.agentManager, 'resumeAgent');

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/resume',
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/being deleted/);
    expect(resumeSpy).not.toHaveBeenCalled();

    // 清理 claim 避免影响后续测试
    app.ctx.agentManager.releaseDeletionClaim(['dev-1']);
  });
});

describe('POST /api/projects/:projectId/agents/:agentId/restart-repl', () => {
  it('happy path: restartReplOnly invoked + 200', async () => {
    const restartSpy = vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/restart-repl',
    });

    expect(response.statusCode).toBe(200);
    expect(restartSpy).toHaveBeenCalledWith('dev-1');
  });

  it('QA with stale binding acquires lock; release on failure does not deadlock', async () => {
    await app.ctx.agentStore.set({
      id: 'qa-1',
      projectId: 'proj',
      taskId: 'task-x',
      updatedAt: new Date().toISOString(),
    });
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/qa-1/restart-repl',
    });

    expect(response.statusCode).toBe(200);
    expect(await app.ctx.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('dev waiting + active task + lock held → takeover (no acquire, no release after success)', async () => {
    await app.ctx.taskStore.set({
      id: 'task-tk1',
      projectId: 'proj',
      title: 't',
      description: 'd',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      reviewRound: 0,
      status: 'review',
      branch: 'bx/task-tk1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await app.ctx.agentStore.set({
      id: 'dev-1', projectId: 'proj', taskId: 'task-tk1',
      updatedAt: new Date().toISOString(),
    });
    await app.ctx.lockManager.acquire('dev-1');
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();
    vi.spyOn(app.ctx.agentManager, 'markAgentWaiting').mockResolvedValue(true);

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/restart-repl',
    });

    expect(response.statusCode).toBe(200);
    expect(await app.ctx.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('creationToken → 409 (op-aware gate)', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      creationToken: 'tok',
      updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/restart-repl',
    });
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/being created/);
  });

  it('restart-repl clears awaiting_human Held state on active task (markAgentWaiting allowAwaitingHuman+clearAwaitingHuman)', async () => {
    // Explicit operator restart invalidates prior ack_unknown / dialog_pending Held; without clearing, Resume also refuses → stuck.
    // Active task takes the takeover path (dev role + active task).
    await app.ctx.taskStore.set({
      id: 'task-clear-held',
      projectId: 'proj',
      title: 't', description: 'd',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      reviewRound: 0, status: 'review',
      branch: 'bx/task-clear-held',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await app.ctx.agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: 'task-clear-held', paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'simulated prior ack_unknown',
      awaitingSince: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await app.ctx.lockManager.acquire('dev-1');
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/restart-repl',
    });

    expect(response.statusCode).toBe(200);
    const state = await app.ctx.agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.awaitingReason).toBeUndefined();
    expect(state?.awaitingSince).toBeUndefined();
    expect(state?.taskId).toBe('task-clear-held'); // binding 保留
  });

  it('returns 404 when agent is not in the project', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/no-such/agents/dev-1/restart-repl',
    });
    expect(response.statusCode).toBe(404);
  });

  it('restartReplOnly throws → 500 with the manager-side message', async () => {
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockRejectedValue(
      new Error('restart-repl precondition failed: unexpected pane state vim'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/restart-repl',
    });
    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/precondition failed/);
  });
});

describe('POST /api/projects/:projectId/agents/:agentId/retry', () => {
  it('absent tmux probe status → ensureSession runtime + 200 + paneId persisted', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString(),
    });
    app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'absent' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/retry',
    });

    expect(response.statusCode).toBe(200);
    const stateAfter = await app.ctx.agentStore.get('dev-1');
    expect(stateAfter?.paneId).toBe('%0');
  });

  it('unknown tmux probe status still lets retry attempt recovery', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/retry',
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses present tmux probe status → 409', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString(),
    });
    app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'present' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/retry',
    });
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/already ready/);
  });

  it('retry hitting NEW dialog during ensureSession → 202 + dialog_pending state, NOT 500 + kill', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString(),
    });
    const { EnsureSessionError } = await import('../../src/agent/manager.js');
    vi.spyOn(app.ctx.agentManager, 'ensureSession').mockRejectedValueOnce(
      new EnsureSessionError(
        {
          createdSession: true,
          agentId: 'dev-1',
          dialogPending: true,
          lastScreen: 'Press enter to continue',
        },
        'buildFreshSession failed: repl not ready',
      ),
    );
    const handleSpy = vi.spyOn(app.ctx.agentManager, 'handleDialogPendingFromRuntime')
      .mockResolvedValue(true);

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/retry',
    });

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body);
    expect(body.runtimeStatus).toBe('pending');
    expect(body.message).toMatch(/web terminal/);
    expect(handleSpy).toHaveBeenCalledWith('dev-1', expect.any(EnsureSessionError));
  });

  it('creationToken pending → 409 (operator-action hint, not 500)', async () => {
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      creationToken: 'tok',
      updatedAt: new Date().toISOString(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/agents/dev-1/retry',
    });
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/being created/);
  });

  it('returns 404 when agent is not in the project', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/no-such/agents/dev-1/retry',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/projects/:id/bootstrap', () => {
  it('returns 503 when bootstrapPoller is not initialised', async () => {
    // Default test context omits bootstrapPoller (it's optional in AppContext); guard against
    // the route 500-ing in that case — surface a clear "feature not available" instead.
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/bootstrap',
    });
    expect(response.statusCode).toBe(503);
  });

  it('returns 404 when pollProject reports knownProject=false (e.g. PATCH-then-restart race)', async () => {
    // Validation source of truth is the poller's view of config, not ctx.config — those can
    // diverge during a PATCH /config window. Without this, the operator would see a misleading
    // ok:true ran:0 success for a project the active poller never targets.
    app.ctx.bootstrapPoller = {
      pollProject: vi.fn().mockResolvedValue({ ok: false, ran: 0, knownProject: false }),
      stop: () => {},
    } as never;
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/some-id/bootstrap',
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toMatch(/restart/i);
  });

  it('delegates to bootstrapPoller.pollProject and returns the result', async () => {
    const pollProject = vi.fn().mockResolvedValue({ ok: true, ran: 2, knownProject: true });
    app.ctx.bootstrapPoller = { pollProject, stop: () => {} } as never;
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/bootstrap',
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, ran: 2 });
    expect(pollProject).toHaveBeenCalledWith('proj');
  });

  it('surfaces ran=0 (no auto-mode agents) with an explanatory message instead of "failed"', async () => {
    // Project exists but all its agents have explicit workdir → BootstrapPoller has nothing
    // to do; success, not failure. Operators shouldn't see a warn toast for this case.
    app.ctx.bootstrapPoller = {
      pollProject: vi.fn().mockResolvedValue({ ok: true, ran: 0, knownProject: true }),
      stop: () => {},
    } as never;
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/proj/bootstrap',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.ran).toBe(0);
    expect(body.message).toMatch(/no bootstrap targets/);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('removes an empty project and hot-reloads config', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'gone', repo: 'a/b' } });
    const agentReplace = vi.spyOn(app.ctx.agentManager, 'replaceConfig');
    const tmuxReplace = vi.fn();
    const bootstrapReplace = vi.fn();
    app.ctx.tmuxProbePoller = { replaceConfig: tmuxReplace, stop: vi.fn() } as never;
    app.ctx.bootstrapPoller = { replaceConfig: bootstrapReplace, stop: vi.fn() } as never;

    const response = await app.inject({ method: 'DELETE', url: '/api/projects/gone' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({ removed: 'gone', restartRequired: false });
    expect(app.ctx.config.project.some(p => p.id === 'gone')).toBe(false);
    expect(agentReplace).toHaveBeenCalledTimes(1);
    expect(tmuxReplace).toHaveBeenCalledTimes(1);
    expect(bootstrapReplace).toHaveBeenCalledTimes(1);
  });

  it('persists the removal to baxian.json', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'persist-del', repo: 'a/b' } });
    await app.inject({ method: 'DELETE', url: '/api/projects/persist-del' });
    const written = JSON.parse(await readFile(configPath, 'utf-8')) as BaxianConfig;
    expect(written.project.some(p => p.id === 'persist-del')).toBe(false);
  });

  it('returns 404 for unknown project', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/projects/nope' });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toMatch(/not found/i);
  });

  it('returns 409 and leaves config intact when the project still has agents', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'busy', repo: 'a/b' } });
    await app.inject({
      method: 'POST', url: '/api/projects/busy/agents',
      payload: { id: 'busy-dev', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
    });

    const response = await app.inject({ method: 'DELETE', url: '/api/projects/busy' });
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/agent/i);
    expect(body.agents).toEqual(['busy-dev']);
    expect(app.ctx.config.project.some(p => p.id === 'busy')).toBe(true);
  });

  it('deleting one project preserves siblings', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'keep-me', repo: 'a/b' } });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'drop-me', repo: 'c/d' } });
    const response = await app.inject({ method: 'DELETE', url: '/api/projects/drop-me' });
    expect(response.statusCode).toBe(200);
    const ids = app.ctx.config.project.map(p => p.id);
    expect(ids).toContain('keep-me');
    expect(ids).not.toContain('drop-me');
  });

  it('after delete the same id can be recreated', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'recycle', repo: 'a/b' } });
    await app.inject({ method: 'DELETE', url: '/api/projects/recycle' });
    const create = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { id: 'recycle', repo: 'a/b' },
    });
    expect(create.statusCode).toBe(201);
  });
});
