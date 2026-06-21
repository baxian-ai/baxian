import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { BaxianConfig } from '../../src/shared/index.js';
import { buildApp } from '../../src/app.js';
import { createTestContext } from '../helpers/context.js';
import { requesters } from './helpers.js';

let tempDir: string;
let app: FastifyInstance;
let configPath: string;
const { post, del } = requesters(() => app);

// Standard agent-create bodies; spread + override per case.
function devAgent(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true, ...extra };
}
function qaAgent(id: string, pairWith: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, runtime: 'codex', role: 'qa', mode: 'local', yolo: true, pairWith, ...extra };
}

function createProject(id: string, extra: Record<string, unknown> = {}): ReturnType<typeof post> {
  return post('/api/projects', { id, repo: 'a/b', ...extra });
}
function addAgent(projectId: string, body: Record<string, unknown>): ReturnType<typeof post> {
  return post(`/api/projects/${projectId}/agents`, body);
}
function findProject(id: string) {
  return app.ctx.config.project.find(p => p.id === id)!;
}
function now(): string {
  return new Date().toISOString();
}

// Create a project and append a dev agent — the common DELETE/resume/retry precondition.
async function projectWithDev(projectId: string, devId: string): Promise<void> {
  await createProject(projectId);
  await addAgent(projectId, devAgent(devId));
}

type AgentFacts = Parameters<FastifyInstance['ctx']['agentStore']['set']>[0];
type TaskFacts = Parameters<FastifyInstance['ctx']['taskStore']['set']>[0];

// Seed agent binding facts; projectId + updatedAt default per the agent id / now().
function seedAgent(id: string, projectId: string, extra: Partial<AgentFacts> = {}): Promise<void> {
  return app.ctx.agentStore.set({ id, projectId, updatedAt: now(), ...extra } as AgentFacts);
}

// Seed a task; the boilerplate title/description/reviewRound/timestamps default unless overridden.
function seedTask(id: string, projectId: string, extra: Partial<TaskFacts> = {}): Promise<void> {
  return app.ctx.taskStore.set({
    id, projectId, title: 't', description: 'd', reviewRound: 0,
    createdAt: now(), updatedAt: now(), ...extra,
  } as TaskFacts);
}

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
    const response = await post('/api/projects', { id: 'newproj', repo: 'baxian-ai/baxian', merge: null });
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

    const response = await post('/api/projects', { id: 'hot', repo: 'a/b' });
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
    const res = await post('/api/projects', { id: 'nopath', repo: 'c/d' });
    expect(res.statusCode).toBe(201);
    expect(pollerReplace.mock.calls[0][1].statePathFor).toBeUndefined();
  });

  it('defaults merge to null when omitted', async () => {
    const response = await post('/api/projects', { id: 'p2', repo: 'a/b' });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.project.merge).toBeNull();
  });

  it('persists project review mode when provided', async () => {
    const response = await post('/api/projects', { id: 'serverproj', repo: 'a/server', review: { mode: 'server' } });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.project.review).toEqual({ mode: 'server' });
    expect(app.ctx.config.project.find(p => p.id === 'serverproj')?.review?.mode).toBe('server');
  });

  it('creates a non-github project with an explicit server review mode override', async () => {
    const response = await post('/api/projects', {
      id: 'gitlabproj', repo: 'https://gitlab.example.com/group/proj.git', review: { mode: 'server' },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.project.review).toEqual({ mode: 'server' });
  });

  // Rejected create payloads. `proj` already exists in the default context → duplicate 409.
  it.each([
    ['non-github repo falling back to github review → 400', { id: 'gitlabproj', repo: 'https://gitlab.example.com/group/proj.git' }, 400],
    ['duplicate project id → 409', { id: 'proj', repo: 'a/b' }, 409],
    ['invalid repo format → 400', { id: 'badrepo', repo: 'not-a-valid-repo' }, 400],
    ['empty id → 400', { id: '', repo: 'a/b' }, 400],
  ] as const)('%s', async (_label, body, status) => {
    const response = await post('/api/projects', body);
    expect(response.statusCode).toBe(status);
  });

  it('creates a project from a git URL repo and stores it verbatim', async () => {
    for (const [id, repo] of [
      ['urlhttps', 'https://github.com/example-owner/example-repo.git'],
      ['urlssh', 'git@github.com:example-owner/example-repo.git'],
    ] as const) {
      const response = await post('/api/projects', { id, repo, merge: null });
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
      const response = await post('/api/projects', { id, repo, merge: null, review: { mode: 'server' } });
      expect.soft(response.statusCode, repo).toBe(201);
      expect.soft(JSON.parse(response.body).project.repo, repo).toBe(repo);
    }
  });

  it('writes to baxian.json with backup', async () => {
    await createProject('persisted');
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
    await createProject('empty');

    const response = await addAgent('empty', devAgent('new-dev'));
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.agent.id).toBe('new-dev');
    expect(body.agent.yolo).toBe(true);

    const proj = findProject('empty');
    expect(proj.agent).toHaveLength(1);
    expect(proj.agent[0]).toHaveLength(1);
    expect(proj.agent[0][0].id).toBe('new-dev');
  });

  it('returns restartRequired:false — agent CRUD is hot-loaded via replaceConfig, no restart needed', async () => {
    await createProject('rr1');
    const response = await addAgent('rr1', devAgent('rr1-dev'));
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.restartRequired).toBe(false);
    expect(app.ctx.agentManager.getAgentConfig('rr1-dev')).toBeDefined();
    expect(await app.ctx.agentStore.get('rr1-dev')).not.toBeNull();
  });

  it('appends a qa agent to existing dev pair when pairWith provided', async () => {
    await projectWithDev('pp3', 'pp3-dev');

    const response = await addAgent('pp3', qaAgent('pp3-qa', 'pp3-dev'));
    expect(response.statusCode).toBe(201);
    const proj = findProject('pp3');
    expect(proj.agent).toHaveLength(1);
    expect(proj.agent[0]).toHaveLength(2);
    expect(proj.agent[0][1].id).toBe('pp3-qa');
  });

  it('returns 404 when project does not exist', async () => {
    const response = await addAgent('no-such', { id: 'xx', runtime: 'codex', role: 'dev', mode: 'local', yolo: true });
    expect(response.statusCode).toBe(404);
  });

  it('returns 409 when agent.id is taken globally', async () => {
    await createProject('pp');
    const response = await addAgent('pp', { id: 'dev-1', runtime: 'codex', role: 'dev', mode: 'local', yolo: true });
    expect(response.statusCode).toBe(409);
    expect(vi.mocked(app.ctx.agentManager.ensureSession)).not.toHaveBeenCalled();
  });

  it('returns 400 when role=qa but no pairWith provided', async () => {
    await projectWithDev('pq', 'pq-dev');

    const response = await addAgent('pq', { id: 'pq-qa', runtime: 'codex', role: 'qa', mode: 'local', yolo: true });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when pairWith refers to dev that already has a qa', async () => {
    await projectWithDev('pf', 'pf-dev');
    await addAgent('pf', qaAgent('pf-qa1', 'pf-dev'));

    const response = await addAgent('pf', qaAgent('pf-qa2', 'pf-dev'));
    expect(response.statusCode).toBe(400);
  });

  // Bad agent bodies against a fresh empty project → 400 (no extra agents needed in setup).
  it.each([
    ['mode=remote but host missing', 'pr', devAgent('pr-dev', { mode: 'remote' })],
    ['empty body / role missing', 'pe', {}],
    ['role is not dev or qa', 'pi', { id: 'pi-x', runtime: 'codex', role: 'invalid', mode: 'local', yolo: true }],
  ] as const)('returns 400 when %s', async (_label, projectId, body) => {
    await createProject(projectId);
    const response = await addAgent(projectId, body);
    expect(response.statusCode).toBe(400);
  });
});

describe('DELETE /api/projects/:projectId/agents/:agentId', () => {
  it('removes orphan dev (sole member of pair) and returns it', async () => {
    await projectWithDev('da1', 'da1-dev');

    const response = await del('/api/projects/da1/agents/da1-dev');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.removed).toEqual(['da1-dev']);

    expect(findProject('da1').agent).toEqual([]);
  });

  it('returns restartRequired:false on delete — symmetric with create', async () => {
    await projectWithDev('rrd', 'rrd-dev');
    const response = await del('/api/projects/rrd/agents/rrd-dev');
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
    await projectWithDev('purge1', 'purge1-dev');
    await del('/api/projects/purge1/agents/purge1-dev');
    expect(purgeAgent).toHaveBeenCalledWith('purge1-dev');
  });

  it('removes paired dev together with its qa', async () => {
    await projectWithDev('da2', 'da2-dev');
    await addAgent('da2', qaAgent('da2-qa', 'da2-dev'));

    const response = await del('/api/projects/da2/agents/da2-dev');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.removed).toEqual(['da2-dev', 'da2-qa']);

    expect(findProject('da2').agent).toEqual([]);
  });

  it('removes only the qa, leaving dev', async () => {
    await projectWithDev('da3', 'da3-dev');
    await addAgent('da3', qaAgent('da3-qa', 'da3-dev'));

    const response = await del('/api/projects/da3/agents/da3-qa');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.removed).toEqual(['da3-qa']);

    expect(findProject('da3').agent).toEqual([[expect.objectContaining({ id: 'da3-dev' })]]);
  });

  it('returns 409 when the agent is bound to an active task', async () => {
    await projectWithDev('da-busy', 'da-busy-dev');
    await seedAgent('da-busy-dev', 'da-busy', { taskId: 'task-da-busy' });
    await seedTask('task-da-busy', 'da-busy', {
      preferredAgentId: 'da-busy-dev', agentId: 'da-busy-dev', status: 'in_progress',
    });

    const response = await del('/api/projects/da-busy/agents/da-busy-dev');
    expect(response.statusCode).toBe(409);

    expect(findProject('da-busy').agent[0][0].id).toBe('da-busy-dev');
  });

  it('cascading dev delete is blocked if its paired qa is active', async () => {
    await projectWithDev('da-pair-busy', 'da-pair-dev');
    await addAgent('da-pair-busy', qaAgent('da-pair-qa', 'da-pair-dev'));
    await seedAgent('da-pair-qa', 'da-pair-busy', { taskId: 'task-da-pair' });
    await seedTask('task-da-pair', 'da-pair-busy', {
      preferredAgentId: 'da-pair-dev', agentId: 'da-pair-dev', qaAgentId: 'da-pair-qa', status: 'review',
    });

    const response = await del('/api/projects/da-pair-busy/agents/da-pair-dev');
    expect(response.statusCode).toBe(409);

    expect(findProject('da-pair-busy').agent[0]).toHaveLength(2);
  });

  it('fresh-bootstrap dialog_pending agent can be DELETEd without waiting for slowPoll timeout', async () => {
    await projectWithDev('da-dialog', 'da-dialog-dev');
    await seedAgent('da-dialog-dev', 'da-dialog', { paneId: '%0' });

    const response = await del('/api/projects/da-dialog/agents/da-dialog-dev');
    expect(response.statusCode).toBe(200);
    expect(findProject('da-dialog').agent).toEqual([]);
  });

  it('awaiting_human agent with creationToken set is DELETable (dialog_pending exit)', async () => {
    await projectWithDev('da-dialog-tok', 'da-dialog-tok-dev');
    // dialog_pending：markDialogPending 设的 status='awaiting_human' + creationToken 仍持有。
    await seedAgent('da-dialog-tok-dev', 'da-dialog-tok', {
      creationToken: 'tok-pending', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending',
    });

    const response = await del('/api/projects/da-dialog-tok/agents/da-dialog-tok-dev');
    expect(response.statusCode).toBe(200);
    expect(findProject('da-dialog-tok').agent).toEqual([]);
  });

  it('awaiting_human agent with NO paneId is still DELETable (getSinglePaneId 持续失败的退路)', async () => {
    await projectWithDev('da-boot', 'da-boot-dev');
    await seedAgent('da-boot-dev', 'da-boot', {
      creationToken: 'tok-bootstrapping',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending',
    });

    const response = await del('/api/projects/da-boot/agents/da-boot-dev');
    expect(response.statusCode).toBe(200);
    expect(findProject('da-boot').agent).toEqual([]);
  });

  it('concurrent DELETEs on the same awaiting_human agent: second request gets 409 (deletionInFlight claim)', async () => {
    // Without the claim, two cleanupRemovedAgentRuntime calls race on the same tmux/worktree via the stale-lock takeover path.
    await projectWithDev('da-dup', 'da-dup-dev');
    await seedAgent('da-dup-dev', 'da-dup', {
      paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    await app.ctx.lockManager.acquire('da-dup-dev');

    // 让 cleanupRemovedAgentRuntime 阻塞，使两个 DELETE phase2 必然重叠
    let resolveCleanup: () => void = () => undefined;
    const cleanupGate = new Promise<void>((resolve) => { resolveCleanup = resolve; });
    const cleanupSpy = vi.spyOn(app.ctx.agentManager, 'cleanupRemovedAgentRuntime')
      .mockImplementation(async () => { await cleanupGate; });

    const first = del('/api/projects/da-dup/agents/da-dup-dev');
    // 让 first 进入 phase2（cleanupRemovedAgentRuntime 等 cleanupGate）
    await new Promise((r) => setTimeout(r, 20));
    const second = await del('/api/projects/da-dup/agents/da-dup-dev');

    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error).toMatch(/deletion already in progress/);

    resolveCleanup();
    const firstResp = await first;
    expect(firstResp.statusCode).toBe(200);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('awaiting_human with stale lock: DELETE takes over (does not 409 on acquire failure)', async () => {
    await projectWithDev('da-stale', 'da-stale-dev');
    await seedAgent('da-stale-dev', 'da-stale', {
      paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    // 模拟 awaiting_human 状态：前任 op 留下 stale lock 没 release
    await app.ctx.lockManager.acquire('da-stale-dev');

    const response = await del('/api/projects/da-stale/agents/da-stale-dev');
    expect(response.statusCode).toBe(200);
    // phase 3 应已清掉 stale lock
    expect(await app.ctx.lockManager.isLocked('da-stale-dev')).toBe(false);
  });

  it('awaiting_human + active task is REFUSED (cannot leave orphan task)', async () => {
    await projectWithDev('da-aw-active', 'da-aw-active-dev');
    await seedTask('task-orphan-risk', 'da-aw-active', {
      preferredAgentId: 'da-aw-active-dev', agentId: 'da-aw-active-dev', status: 'in_progress',
    });
    await seedAgent('da-aw-active-dev', 'da-aw-active', {
      taskId: 'task-orphan-risk', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending',
    });

    const response = await del('/api/projects/da-aw-active/agents/da-aw-active-dev');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/cancel the task before deleting/);
  });

  it('dev reserved by a max_rounds task is REFUSED (max_rounds is active; deleting would orphan it)', async () => {
    await projectWithDev('da-mr-active', 'da-mr-active-dev');
    await seedTask('task-mr-reserved', 'da-mr-active', {
      preferredAgentId: 'da-mr-active-dev', agentId: 'da-mr-active-dev', reviewRound: 10,
      status: 'max_rounds', prNumber: 7, branch: 'bx/task-mr-reserved',
    });
    await seedAgent('da-mr-active-dev', 'da-mr-active', {
      taskId: 'task-mr-reserved', paneId: '%0', status: 'waiting', worktreePath: '/tmp/wt',
    });

    const response = await del('/api/projects/da-mr-active/agents/da-mr-active-dev');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/cancel the task before deleting/);
  });

  it('refuses deleting an UNBOUND agent still referenced by an active task (spec max_rounds preferredAgentId)', async () => {
    await projectWithDev('da-mr-ref', 'da-mr-ref-dev');
    // spec-phase max_rounds: dev released (agentId cleared) but preferredAgentId kept for Retry.
    await seedTask('task-spec-mr-ref', 'da-mr-ref', {
      preferredAgentId: 'da-mr-ref-dev', agentId: '', reviewRound: 5,
      status: 'max_rounds', phase: 'spec', prNumber: 8, branch: 'bx/task-spec-mr-ref',
    });
    // agent is idle/unbound (no taskId) — the binding-based guard alone would allow deletion.
    await seedAgent('da-mr-ref-dev', 'da-mr-ref', { status: 'idle', paneId: '%0' });

    const response = await del('/api/projects/da-mr-ref/agents/da-mr-ref-dev');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/referenced by active task/);
  });

  it('bootstrap-in-progress (creationToken set, status ok) returns 409', async () => {
    await projectWithDev('da-boot-progress', 'da-boot-progress-dev');
    await seedAgent('da-boot-progress-dev', 'da-boot-progress', { creationToken: 'tok-active-bootstrap' });

    const response = await del('/api/projects/da-boot-progress/agents/da-boot-progress-dev');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/bootstrapping/);
  });

  it('terminal-status agents (idle/done/failed) can still be deleted', async () => {
    await projectWithDev('da-idle', 'da-idle-dev');
    await seedAgent('da-idle-dev', 'da-idle');

    const response = await del('/api/projects/da-idle/agents/da-idle-dev');
    expect(response.statusCode).toBe(200);
  });

  it('preserves other pairs when deleting from a multi-pair project', async () => {
    await createProject('da4');
    await addAgent('da4', devAgent('da4-dev1'));
    await addAgent('da4', devAgent('da4-dev2'));
    await addAgent('da4', devAgent('da4-dev3'));

    const response = await del('/api/projects/da4/agents/da4-dev2');
    expect(response.statusCode).toBe(200);

    const proj = findProject('da4');
    expect(proj.agent).toHaveLength(2);
    expect(proj.agent[0][0].id).toBe('da4-dev1');
    expect(proj.agent[1][0].id).toBe('da4-dev3');
  });

  it.each([
    ['unknown agent', '/api/projects/proj/agents/no-such'],
    ['unknown project', '/api/projects/no-such/agents/dev-1'],
  ] as const)('returns 404 for %s', async (_label, url) => {
    const response = await del(url);
    expect(response.statusCode).toBe(404);
  });

  it('Phase 3 saveConfig fails → 500 + rollbackPerTargetState + lock released', async () => {
    await projectWithDev('da-rb', 'da-rb-dev');
    await seedAgent('da-rb-dev', 'da-rb', { paneId: '%0', repoPath: '/tmp/repo' });

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

    const response = await del('/api/projects/da-rb/agents/da-rb-dev');

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
    await seedAgent('dev-1', 'proj', { status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    const resumeSpy = vi.spyOn(app.ctx.agentManager, 'resumeAgent')
      .mockResolvedValue({ resumed: true, releasedBinding: true });

    const response = await post('/api/projects/proj/agents/dev-1/resume');

    expect(response.statusCode).toBe(200);
    expect(resumeSpy).toHaveBeenCalledWith('dev-1');
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({ agentId: 'dev-1', resumed: true, releasedBinding: true });
  });

  it('resume returns 409 when manager reports resumed=false (e.g. creationToken still set)', async () => {
    await seedAgent('dev-1', 'proj', {
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending', creationToken: 'tok-pending',
    });
    vi.spyOn(app.ctx.agentManager, 'resumeAgent')
      .mockResolvedValue({ resumed: false, releasedBinding: false });

    const response = await post('/api/projects/proj/agents/dev-1/resume');

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/Bootstrap dialog still unresolved/);
    expect(body.resumed).toBe(false);
  });

  it('agent not awaiting_human: 409', async () => {
    await seedAgent('dev-1', 'proj');

    const response = await post('/api/projects/proj/agents/dev-1/resume');

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/not awaiting human/);
  });

  it('unknown agent: 404', async () => {
    const response = await post('/api/projects/proj/agents/no-such/resume');
    expect(response.statusCode).toBe(404);
  });

  it('resume during DELETE cleanup (deletionInFlight): 409 (no resumeAgent invocation, prevents race with phase2 cleanup)', async () => {
    // DELETE phase2 runs without withConfigLock; Resume must check deletionInFlight or it dispatches into a tmux/worktree being torn down.
    await seedAgent('dev-1', 'proj', { status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    // 模拟 DELETE phase1 已 claim deletion，phase2 cleanup 中
    app.ctx.agentManager.tryClaimDeletion(['dev-1']);
    const resumeSpy = vi.spyOn(app.ctx.agentManager, 'resumeAgent');

    const response = await post('/api/projects/proj/agents/dev-1/resume');

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

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    expect(restartSpy).toHaveBeenCalledWith('dev-1');
  });

  it('QA with stale binding acquires lock; release on failure does not deadlock', async () => {
    await seedAgent('qa-1', 'proj', { taskId: 'task-x' });
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await post('/api/projects/proj/agents/qa-1/restart-repl');

    expect(response.statusCode).toBe(200);
    expect(await app.ctx.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('dev waiting + active task + lock held → takeover (no acquire, no release after success)', async () => {
    await seedTask('task-tk1', 'proj', {
      preferredAgentId: 'dev-1', agentId: 'dev-1', status: 'review', branch: 'bx/task-tk1',
    });
    await seedAgent('dev-1', 'proj', { taskId: 'task-tk1' });
    await app.ctx.lockManager.acquire('dev-1');
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();
    vi.spyOn(app.ctx.agentManager, 'markAgentWaiting').mockResolvedValue(true);

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    expect(await app.ctx.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('creationToken → 409 (op-aware gate)', async () => {
    await seedAgent('dev-1', 'proj', { creationToken: 'tok' });

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/being created/);
  });

  it('restart-repl clears awaiting_human Held state on active task (markAgentWaiting allowAwaitingHuman+clearAwaitingHuman)', async () => {
    // Explicit operator restart invalidates prior ack_unknown / dialog_pending Held; without clearing, Resume also refuses → stuck.
    // Active task takes the takeover path (dev role + active task).
    await seedTask('task-clear-held', 'proj', {
      preferredAgentId: 'dev-1', agentId: 'dev-1', status: 'review', branch: 'bx/task-clear-held',
    });
    await seedAgent('dev-1', 'proj', {
      taskId: 'task-clear-held', paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'simulated prior ack_unknown',
      awaitingSince: now(),
    });
    await app.ctx.lockManager.acquire('dev-1');
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    const state = await app.ctx.agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.awaitingReason).toBeUndefined();
    expect(state?.awaitingSince).toBeUndefined();
    expect(state?.taskId).toBe('task-clear-held'); // binding 保留
  });

  it('returns 404 when agent is not in the project', async () => {
    const response = await post('/api/projects/no-such/agents/dev-1/restart-repl');
    expect(response.statusCode).toBe(404);
  });

  it('restartReplOnly throws → 500 with the manager-side message', async () => {
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockRejectedValue(
      new Error('restart-repl precondition failed: unexpected pane state vim'),
    );

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');
    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/precondition failed/);
  });
});

describe('POST /api/projects/:projectId/agents/:agentId/retry', () => {
  it('absent tmux probe status → ensureSession runtime + 200 + paneId persisted', async () => {
    await seedAgent('dev-1', 'proj');
    app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'absent' });

    const response = await post('/api/projects/proj/agents/dev-1/retry');

    expect(response.statusCode).toBe(200);
    const stateAfter = await app.ctx.agentStore.get('dev-1');
    expect(stateAfter?.paneId).toBe('%0');
  });

  it('unknown tmux probe status still lets retry attempt recovery', async () => {
    await seedAgent('dev-1', 'proj');

    const response = await post('/api/projects/proj/agents/dev-1/retry');
    expect(response.statusCode).toBe(200);
  });

  it('refuses present tmux probe status → 409', async () => {
    await seedAgent('dev-1', 'proj');
    app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'present' });

    const response = await post('/api/projects/proj/agents/dev-1/retry');
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/already ready/);
  });

  it('retry hitting NEW dialog during ensureSession → 202 + dialog_pending state, NOT 500 + kill', async () => {
    await seedAgent('dev-1', 'proj');
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

    const response = await post('/api/projects/proj/agents/dev-1/retry');

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body);
    expect(body.runtimeStatus).toBe('pending');
    expect(body.message).toMatch(/web terminal/);
    expect(handleSpy).toHaveBeenCalledWith('dev-1', expect.any(EnsureSessionError));
  });

  it('creationToken pending → 409 (operator-action hint, not 500)', async () => {
    await seedAgent('dev-1', 'proj', { creationToken: 'tok' });
    const response = await post('/api/projects/proj/agents/dev-1/retry');
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/being created/);
  });

  it('returns 404 when agent is not in the project', async () => {
    const response = await post('/api/projects/no-such/agents/dev-1/retry');
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/projects/:id/bootstrap', () => {
  it('returns 503 when bootstrapPoller is not initialised', async () => {
    // Default test context omits bootstrapPoller (it's optional in AppContext); guard against
    // the route 500-ing in that case — surface a clear "feature not available" instead.
    const response = await post('/api/projects/proj/bootstrap');
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
    const response = await post('/api/projects/some-id/bootstrap');
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toMatch(/restart/i);
  });

  it('delegates to bootstrapPoller.pollProject and returns the result', async () => {
    const pollProject = vi.fn().mockResolvedValue({ ok: true, ran: 2, knownProject: true });
    app.ctx.bootstrapPoller = { pollProject, stop: () => {} } as never;
    const response = await post('/api/projects/proj/bootstrap');
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
    const response = await post('/api/projects/proj/bootstrap');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.ran).toBe(0);
    expect(body.message).toMatch(/no bootstrap targets/);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('removes an empty project and hot-reloads config', async () => {
    await createProject('gone');
    const agentReplace = vi.spyOn(app.ctx.agentManager, 'replaceConfig');
    const tmuxReplace = vi.fn();
    const bootstrapReplace = vi.fn();
    app.ctx.tmuxProbePoller = { replaceConfig: tmuxReplace, stop: vi.fn() } as never;
    app.ctx.bootstrapPoller = { replaceConfig: bootstrapReplace, stop: vi.fn() } as never;

    const response = await del('/api/projects/gone');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({ removed: 'gone', restartRequired: false });
    expect(app.ctx.config.project.some(p => p.id === 'gone')).toBe(false);
    expect(agentReplace).toHaveBeenCalledTimes(1);
    expect(tmuxReplace).toHaveBeenCalledTimes(1);
    expect(bootstrapReplace).toHaveBeenCalledTimes(1);
  });

  it('persists the removal to baxian.json', async () => {
    await createProject('persist-del');
    await del('/api/projects/persist-del');
    const written = JSON.parse(await readFile(configPath, 'utf-8')) as BaxianConfig;
    expect(written.project.some(p => p.id === 'persist-del')).toBe(false);
  });

  it('returns 404 for unknown project', async () => {
    const response = await del('/api/projects/nope');
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toMatch(/not found/i);
  });

  it('returns 409 and leaves config intact when the project still has agents', async () => {
    await projectWithDev('busy', 'busy-dev');

    const response = await del('/api/projects/busy');
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/agent/i);
    expect(body.agents).toEqual(['busy-dev']);
    expect(app.ctx.config.project.some(p => p.id === 'busy')).toBe(true);
  });

  it('deleting one project preserves siblings', async () => {
    await createProject('keep-me');
    await createProject('drop-me', { repo: 'c/d' });
    const response = await del('/api/projects/drop-me');
    expect(response.statusCode).toBe(200);
    const ids = app.ctx.config.project.map(p => p.id);
    expect(ids).toContain('keep-me');
    expect(ids).not.toContain('drop-me');
  });

  it('after delete the same id can be recreated', async () => {
    await createProject('recycle');
    await del('/api/projects/recycle');
    const create = await createProject('recycle');
    expect(create.statusCode).toBe(201);
  });
});
