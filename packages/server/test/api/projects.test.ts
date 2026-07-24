import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { BaxianConfig } from '../../src/shared/index.js';
import { buildApp } from '../../src/app.js';
import * as loaderModule from '../../src/config/loader.js';
import { ConfigValidationError } from '../../src/config/loader.js';
import * as preflight from '../../src/agent/preflight.js';
import * as tmuxInstall from '../../src/agent/tmux-install.js';
import { CleanupFailedError, EnsureSessionError } from '../../src/agent/manager.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import { createTestContext } from '../helpers/context.js';
import { requesters } from './helpers.js';

let tempDir: string;
let app: FastifyInstance;
let configPath: string;
const { post, put, del } = requesters(() => app);

function devAgent(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true, ...extra };
}
function qaAgent(id: string, pairWith: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, runtime: 'codex', role: 'qa', mode: 'local', yolo: true, pairWith, ...extra };
}
function researchAgent(id: string, pairWith: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, runtime: 'claude-code', role: 'research', mode: 'local', yolo: true, pairWith, ...extra };
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

async function projectWithDev(projectId: string, devId: string): Promise<void> {
  await createProject(projectId);
  await addAgent(projectId, devAgent(devId));
}

type AgentFacts = Parameters<FastifyInstance['ctx']['agentStore']['set']>[0];
type TaskFacts = Parameters<FastifyInstance['ctx']['taskStore']['set']>[0];

function seedAgent(id: string, projectId: string, extra: Partial<AgentFacts> = {}): Promise<void> {
  return app.ctx.agentStore.set({ id, projectId, updatedAt: now(), ...extra } as AgentFacts);
}

function seedTask(id: string, projectId: string, extra: Partial<TaskFacts> = {}): Promise<void> {
  const devAgentId = extra.devAgentId ?? extra.agentId ?? extra.preferredAgentId ?? '';
  const reviewMode = app.ctx.agentManager.effectiveReviewMode(projectId);
  return app.ctx.taskStore.set({
    id, projectId, title: 't', description: 'd', reviewRound: 0,
    preferredAgentId: devAgentId, agentId: devAgentId, devAgentId,
    phase: 'code', reviewMode, status: 'pending',
    ...app.ctx.agentManager.platformBindingFields(projectId),
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
  vi.spyOn(app.ctx.agentManager, 'ensureSession').mockImplementation(async (agentId) => ({
    ok: true,
    createdSession: true,
    paneId: '%0',
    pane: {
      session: { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' },
      paneId: '%0',
      claim: agentId,
    },
    workdir: '/tmp/test',
  }));
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
    const reconcile = vi.fn();
    app.ctx.tmuxProbePoller = { replaceConfig: tmuxReplace, stop: vi.fn() } as never;
    app.ctx.bootstrapPoller = { replaceConfig: bootstrapReplace, stop: vi.fn() } as never;
    app.ctx.poller = { reconcile, reschedule: vi.fn(), stop: vi.fn() } as never;
    app.ctx.platformEntryDeps = {
      driverFor: () => ({ visibilityLagMs: 0, commentSources: [] }),
      statePathFor: (repoUrl: string) => `${tempDir}/poller-${encodeURIComponent(repoUrl)}.json`,
    } as never;
    app.ctx.stateDir = tempDir;

    const response = await post('/api/projects', { id: 'hot', repo: 'a/b' });
    expect(response.statusCode).toBe(201);

    expect(agentReplace).toHaveBeenCalledTimes(1);
    expect(agentReplace.mock.calls[0][0].project.some((p: { id: string }) => p.id === 'hot')).toBe(true);
    expect(tmuxReplace).toHaveBeenCalledTimes(1);
    expect(bootstrapReplace).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const entries = reconcile.mock.calls[0][0] as Array<{ projectId: string; repoUrl: string; statePath: string }>;
    const added = entries.find(e => e.projectId === 'hot');
    expect(added).toBeDefined();
    expect(added!.repoUrl).toBe('a/b');
    expect(added!.statePath).toContain('poller-a%2Fb.json');
  });

  it('skips poller reconciliation when the platform deps are unavailable', async () => {
    const reconcile = vi.fn();
    app.ctx.poller = { reconcile, reschedule: vi.fn(), stop: vi.fn() } as never;
    app.ctx.platformEntryDeps = undefined;
    const res = await post('/api/projects', { id: 'nopath', repo: 'c/d' });
    expect(res.statusCode).toBe(201);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('defaults merge to null when omitted', async () => {
    const response = await post('/api/projects', { id: 'p2', repo: 'a/b' });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.project.merge).toBeNull();
  });

  it('persists specApproval when provided and rejects invalid values', async () => {
    const ok = await post('/api/projects', { id: 'specproj', repo: 'a/spec', specApproval: 'human' });
    expect(ok.statusCode).toBe(201);
    expect(JSON.parse(ok.body).project.specApproval).toBe('human');
    expect(app.ctx.config.project.find(p => p.id === 'specproj')?.specApproval).toBe('human');

    const omitted = await post('/api/projects', { id: 'specless', repo: 'a/specless' });
    expect(omitted.statusCode).toBe(201);
    expect(JSON.parse(omitted.body).project.specApproval).toBeUndefined();

    const bad = await post('/api/projects', { id: 'specbad', repo: 'a/specbad', specApproval: 'qa' });
    expect(bad.statusCode).toBe(400);
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

  it.each([
    ['non-github repo falling back to github review → 400', { id: 'gitlabproj', repo: 'https://gitlab.example.com/group/proj.git' }, 400],
    ['duplicate project id → 409', { id: 'proj', repo: 'a/b' }, 409],
    ['invalid repo format → 400', { id: 'badrepo', repo: 'not-a-valid-repo' }, 400],
    ['empty id → 400', { id: '', repo: 'a/b' }, 400],
  ] as const)('%s', async (_label, body, status) => {
    const response = await post('/api/projects', body);
    expect(response.statusCode).toBe(status);
  });

  it('rejects creating a project on a repo locked by another project\'s active tasks (§5.5)', async () => {
    // 既有项目 proj(repo a/b) 有一个活动的绑定任务;新建 B 指向同一 repo 应 409
    await createProject('proj-owner', { repo: 'https://github.com/shared/repo.git', review: { mode: 'server' } });
    await app.ctx.taskStore.set({
      id: 'task-lock', projectId: 'proj-owner', title: 'T', description: 'D',
      preferredAgentId: '', agentId: '', devAgentId: '',
      status: 'review', reviewMode: 'git', reviewRound: 1,
      platformBinding: { mode: 'git', repoKey: 'github.com/shared/repo', tool: 'gh' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);

    const response = await post('/api/projects', { id: 'intruder', repo: 'git@github.com:shared/repo.git' });

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.tasks).toEqual(['task-lock']);
    expect(body.details).toEqual([{
      path: 'project.intruder.repo',
      message: 'repo is locked by active tasks in project proj-owner: task-lock',
    }]);
    expect(body.error).toMatch(/locked by/);
    expect(app.ctx.config.project.some(p => p.id === 'intruder')).toBe(false);
  });

  it('allows creating a project on a repo whose locking tasks have gone terminal', async () => {
    await createProject('proj-done', { repo: 'https://github.com/free/repo.git', review: { mode: 'server' } });
    await app.ctx.taskStore.set({
      id: 'task-terminal', projectId: 'proj-done', title: 'T', description: 'D',
      preferredAgentId: '', agentId: '', devAgentId: '',
      status: 'merged', reviewMode: 'git', reviewRound: 1,
      platformBinding: { mode: 'git', repoKey: 'github.com/free/repo', tool: 'gh' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);

    const response = await post('/api/projects', { id: 'newcomer', repo: 'git@github.com:free/repo.git' });
    expect(response.statusCode).toBe(201);
  });

  it('creates a project from a git URL repo and stores it verbatim', async () => {
    for (const [id, repo] of [
      ['urlhttps', 'https://github.com/example-owner/example-repo.git'],
      ['urlssh', 'git@github.com:example-owner/other-repo.git'],
    ] as const) {
      const response = await post('/api/projects', { id, repo, merge: null });
      expect(response.statusCode).toBe(201);
      expect(JSON.parse(response.body).project.repo).toBe(repo);
    }
  });

  it('persists a submitted gitCli declaration onto the created project', async () => {
    const response = await post('/api/projects', {
      id: 'withcli',
      repo: 'https://github.com/example-owner/example-repo.git',
      merge: null,
      gitCli: { tool: 'gh', notes: 'runs behind :8443' },
    });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).project.gitCli).toEqual({ tool: 'gh', notes: 'runs behind :8443' });
    const written = JSON.parse(await readFile(configPath, 'utf-8')) as BaxianConfig;
    expect(written.project.find(p => p.id === 'withcli')?.gitCli).toEqual({ tool: 'gh', notes: 'runs behind :8443' });
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

  it('returns 500 when no config path is configured', async () => {
    app.ctx.configPath = undefined;
    const response = await post('/api/projects', { id: 'x', repo: 'a/b' });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toMatch(/No config path/);
  });

  it('returns 400 when repo is missing', async () => {
    const response = await post('/api/projects', { id: 'norepo' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/repo must be a non-empty string/);
  });

  it('rethrows non-validation prepareConfig failures as 500 and persists nothing', async () => {
    vi.spyOn(loaderModule, 'prepareConfig').mockImplementation(() => {
      throw new Error('kaboom');
    });
    const response = await post('/api/projects', { id: 'boom', repo: 'a/b' });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('internal_error');
    expect(app.ctx.config.project.some(p => p.id === 'boom')).toBe(false);
  });
});

describe('POST /api/projects/:id/checks', () => {
  it('returns 404 for an unknown project', async () => {
    const response = await post('/api/projects/no-such/checks');
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toMatch(/not found/i);
  });

  it('runs preflight for every agent in the project and returns 201', async () => {
    const runSpy = vi.spyOn(preflight, 'runPreflight').mockResolvedValue([
      { step: 'cli', ok: true, message: 'claude found' },
    ]);
    const response = await post('/api/projects/proj/checks');
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.projectId).toBe('proj');
    expect(body.agents).toEqual([
      { agentId: 'dev-1', mode: 'local', results: [{ step: 'cli', ok: true, message: 'claude found' }] },
      { agentId: 'qa-1', mode: 'local', results: [{ step: 'cli', ok: true, message: 'claude found' }] },
    ]);
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(body.fixes).toBeUndefined();
  });

  it('does not attempt a tmux install without fix:true even when the tmux check fails', async () => {
    vi.spyOn(preflight, 'runPreflight').mockResolvedValue([
      { step: 'tmux', ok: false, message: 'Please install tmux' },
    ]);
    const installSpy = vi.spyOn(tmuxInstall, 'installTmux');
    const response = await post('/api/projects/proj/checks');
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).fixes).toBeUndefined();
    expect(installSpy).not.toHaveBeenCalled();
  });

  it('installs tmux once per host group with fix:true and re-probes the affected agents', async () => {
    vi.spyOn(preflight, 'runPreflight').mockResolvedValue([
      { step: 'tmux', ok: false, message: 'Please install tmux' },
    ]);
    const installSpy = vi.spyOn(tmuxInstall, 'installTmux').mockResolvedValue({
      ok: true, method: 'brew', version: '3.5', message: 'tmux 3.5 installed via brew',
    });
    const reprobeSpy = vi.spyOn(preflight, 'probeTmux').mockResolvedValue({
      step: 'tmux', ok: true, message: 'tmux found at /opt/homebrew/bin/tmux',
    });

    const response = await post('/api/projects/proj/checks', { fix: true });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(reprobeSpy).toHaveBeenCalledWith(expect.anything(), 'proj');
    expect(body.fixes).toEqual([
      { hostGroup: 'local', ok: true, method: 'brew', version: '3.5', message: 'tmux 3.5 installed via brew' },
    ]);
    for (const agent of body.agents) {
      expect(agent.results).toEqual([
        { step: 'tmux', ok: true, message: 'tmux found at /opt/homebrew/bin/tmux' },
      ]);
    }
  });

  it('keeps the failed tmux results and reports the failure when the install does not succeed', async () => {
    vi.spyOn(preflight, 'runPreflight').mockResolvedValue([
      { step: 'tmux', ok: false, message: 'Please install tmux' },
    ]);
    vi.spyOn(tmuxInstall, 'installTmux').mockResolvedValue({
      ok: false, message: 'cannot install automatically: not root and passwordless sudo is unavailable — run "sudo apt-get install -y tmux" on the host',
    });
    const reprobeSpy = vi.spyOn(preflight, 'probeTmux');

    const response = await post('/api/projects/proj/checks', { fix: true });
    const body = JSON.parse(response.body);
    expect(body.fixes).toHaveLength(1);
    expect(body.fixes[0].ok).toBe(false);
    expect(body.fixes[0].message).toContain('sudo apt-get install -y tmux');
    expect(reprobeSpy).not.toHaveBeenCalled();
    for (const agent of body.agents) {
      expect(agent.results[0].ok).toBe(false);
    }
  });

  it('reports an empty fixes list with fix:true when tmux is present everywhere', async () => {
    vi.spyOn(preflight, 'runPreflight').mockResolvedValue([
      { step: 'tmux', ok: true, message: 'tmux found at /usr/bin/tmux' },
    ]);
    const installSpy = vi.spyOn(tmuxInstall, 'installTmux');
    const response = await post('/api/projects/proj/checks', { fix: true });
    const body = JSON.parse(response.body);
    expect(body.fixes).toEqual([]);
    expect(installSpy).not.toHaveBeenCalled();
  });

  it('adds a server-host check group for effective git projects even with zero agents', async () => {
    await createProject('proj-a');
    const gitPlatform = {
      tool: 'gh', minToolVersion: '1.9.0', steps: [],
      renderCtx: { scheme: 'https', hostname: 'github.com', host: 'github.com', repoPath: 'user/repo', binary: 'gh' },
      driverFor: () => ({ runOp: async () => [{}] }),
    };
    const ctxSpy = vi.spyOn(app.ctx.agentManager, 'agentGitPreflightContext')
      .mockReturnValue(gitPlatform as never);
    const driverSpy = vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue({
      runPreflightSteps: async () => [{ step: 'driver-preflight-1', ok: true, message: 'gh OK' }],
      runOp: async () => [{ defaultBranch: 'main', pushPermitted: false }],
    } as never);
    const response = await post('/api/projects/proj-a/checks', {});
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { agents: unknown[]; server?: { results: Array<{ step: string; ok: boolean }> } };
    expect(body.server).toBeDefined();
    const push = body.server!.results.find(r => r.step === 'platform-push');
    expect(push?.ok).toBe(false);
    ctxSpy.mockRestore();
    driverSpy.mockRestore();
  });

  it('checks gh only on the fixed-workdir dev publisher plus the server platform channel', async () => {
    app.ctx.config.review = { ...app.ctx.config.review, mode: 'server', afterDone: 'pr' };
    app.ctx.config.project[0]!.review = { mode: 'server' };
    app.ctx.config.project[0]!.agent[0]!.push({
      id: 'research-1', runtime: 'claude-code', role: 'research', mode: 'local',
      workdir: join(tempDir, 'research-1'),
    });
    app.ctx.agentManager.replaceConfig(app.ctx.config);
    const runSpy = vi.spyOn(preflight, 'runPreflight').mockResolvedValue([
      { step: 'gh', ok: true, message: 'GitHub CLI authenticated' },
    ]);
    vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue({
      runPreflightSteps: async () => [{ step: 'driver-preflight-1', ok: true, message: 'gh OK' }],
      runOp: async () => [{ defaultBranch: 'main', pushPermitted: true }],
    } as never);

    const response = await post('/api/projects/proj/checks', {});

    expect(response.statusCode).toBe(201);
    expect(runSpy).toHaveBeenCalledTimes(3);
    expect(Object.fromEntries(runSpy.mock.calls.map(call => [call[1].role, call[6]]))).toEqual({
      dev: { requireGitHubCli: true, requireGitPush: true },
      qa: { requireGitHubCli: false, requireGitPush: false },
      research: { requireGitHubCli: false, requireGitPush: false },
    });
    const body = JSON.parse(response.body) as {
      server?: { results: Array<{ step: string; ok: boolean }> };
    };
    expect(body.server?.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'platform-repo', ok: true }),
      expect.objectContaining({ step: 'platform-push', ok: true }),
    ]));
  });

  it('skips platform CLI checks for fixed-workdir research but retains them for git review participants', async () => {
    app.ctx.config.project[0]!.agent[0]!.push({
      id: 'research-1', runtime: 'claude-code', role: 'research', mode: 'local',
      workdir: join(tempDir, 'research-1'),
    });
    app.ctx.agentManager.replaceConfig(app.ctx.config);
    const gitPlatform = {
      tool: 'gh', minToolVersion: '2.40.0', steps: [], agentCommands: [],
      renderCtx: { scheme: 'https', hostname: 'github.com', host: 'github.com', repoPath: 'owner/repo', binary: 'gh' },
      driverFor: () => ({ runOp: async () => [{}] }),
    };
    vi.spyOn(app.ctx.agentManager, 'agentGitPreflightContext').mockReturnValue(gitPlatform as never);
    vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue({
      runPreflightSteps: async () => [],
      runOp: async () => [{ defaultBranch: 'main', pushPermitted: true }],
    } as never);
    const runSpy = vi.spyOn(preflight, 'runPreflight').mockResolvedValue([]);

    const response = await post('/api/projects/proj/checks', {});

    expect(response.statusCode).toBe(201);
    const contexts = Object.fromEntries(runSpy.mock.calls.map(call => [call[1].role, call[5]]));
    expect(contexts.dev).toBe(gitPlatform);
    expect(contexts.qa).toBe(gitPlatform);
    expect(contexts.research).toBeUndefined();
  });

  it('still checks gh for an automatic-workdir QA because bootstrap clones through gh', async () => {
    app.ctx.config.review = { ...app.ctx.config.review, mode: 'server', afterDone: 'pr' };
    app.ctx.config.project[0]!.review = { mode: 'server' };
    app.ctx.config.project[0]!.agent[0]![1]!.workdir = undefined;
    app.ctx.agentManager.replaceConfig(app.ctx.config);
    const runSpy = vi.spyOn(preflight, 'runPreflight').mockResolvedValue([
      { step: 'gh', ok: true, message: 'GitHub CLI authenticated' },
    ]);
    vi.spyOn(app.ctx.agentManager, 'platformDriverFor').mockReturnValue({
      runPreflightSteps: async () => [{ step: 'driver-preflight-1', ok: true, message: 'gh OK' }],
      runOp: async () => [{ defaultBranch: 'main', pushPermitted: true }],
    } as never);

    const response = await post('/api/projects/proj/checks', {});

    expect(response.statusCode).toBe(201);
    const qaCall = runSpy.mock.calls.find(call => call[1].role === 'qa');
    expect(qaCall?.[6]).toEqual({ requireGitHubCli: true, requireGitPush: false });
  });

  it('does not require gh on a fixed Workdir when server review only publishes a branch', async () => {
    app.ctx.config.review = { ...app.ctx.config.review, mode: 'server', afterDone: 'branch' };
    app.ctx.config.project[0]!.review = { mode: 'server' };
    app.ctx.agentManager.replaceConfig(app.ctx.config);
    const runSpy = vi.spyOn(preflight, 'runPreflight').mockResolvedValue([
      { step: 'git', ok: true, message: 'origin push access OK' },
    ]);
    const platformDriver = vi.spyOn(app.ctx.agentManager, 'platformDriverFor');

    const response = await post('/api/projects/proj/checks', {});

    expect(response.statusCode).toBe(201);
    expect(Object.fromEntries(runSpy.mock.calls.map(call => [call[1].role, call[6]]))).toEqual({
      dev: { requireGitHubCli: false, requireGitPush: true },
      qa: { requireGitHubCli: false, requireGitPush: false },
    });
    expect(JSON.parse(response.body).server).toBeUndefined();
    expect(platformDriver).not.toHaveBeenCalled();
  });

  it('does not require push for fixed Workdirs when server review does not publish', async () => {
    app.ctx.config.review = { ...app.ctx.config.review, mode: 'server', afterDone: null };
    app.ctx.config.project[0]!.review = { mode: 'server' };
    app.ctx.agentManager.replaceConfig(app.ctx.config);
    const runSpy = vi.spyOn(preflight, 'runPreflight').mockResolvedValue([
      { step: 'workdir', ok: true, message: 'clone root OK' },
    ]);

    const response = await post('/api/projects/proj/checks', {});

    expect(response.statusCode).toBe(201);
    for (const call of runSpy.mock.calls) {
      expect(call[6]).toEqual({ requireGitHubCli: false, requireGitPush: false });
    }
    expect(JSON.parse(response.body).server).toBeUndefined();
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

  it('accepts yolo: false and persists it (issue #475)', async () => {
    await createProject('ny');

    const response = await addAgent('ny', { ...devAgent('ny-dev'), yolo: false });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.agent.yolo).toBe(false);
    expect(findProject('ny').agent[0][0].yolo).toBe(false);
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

  it('adds QA and Research independently to the same dev group', async () => {
    await projectWithDev('prg', 'prg-dev');
    expect((await addAgent('prg', qaAgent('prg-qa', 'prg-dev'))).statusCode).toBe(201);

    const response = await addAgent('prg', researchAgent('prg-research', 'prg-dev'));

    expect(response.statusCode).toBe(201);
    expect(findProject('prg').agent[0]).toEqual([
      expect.objectContaining({ id: 'prg-dev', role: 'dev' }),
      expect.objectContaining({ id: 'prg-qa', role: 'qa' }),
      expect.objectContaining({ id: 'prg-research', role: 'research' }),
    ]);
  });

  it('rejects a second Research agent in the same dev group', async () => {
    await projectWithDev('pr2', 'pr2-dev');
    expect((await addAgent('pr2', researchAgent('pr2-research-1', 'pr2-dev'))).statusCode).toBe(201);

    const response = await addAgent('pr2', researchAgent('pr2-research-2', 'pr2-dev'));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/has no research yet/);
    expect(findProject('pr2').agent[0].filter(agent => agent.role === 'research')).toHaveLength(1);
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

  it('returns 409 when the agent id is tombstoned by an in-flight deletion (same-id rebuild blocked)', async () => {
    await createProject('td');
    app.ctx.agentManager.tryClaimDeletion(['td-dev']);

    const response = await addAgent('td', devAgent('td-dev'));

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/being deleted/);
    expect(findProject('td').agent).toEqual([]);
    expect(await app.ctx.agentStore.get('td-dev')).toBeNull();

    app.ctx.agentManager.releaseDeletionClaim(['td-dev']);
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

  it.each([
    ['mode=remote but host missing', 'pr', devAgent('pr-dev', { mode: 'remote' })],
    ['empty body / role missing', 'pe', {}],
    ['role is not dev or qa', 'pi', { id: 'pi-x', runtime: 'codex', role: 'invalid', mode: 'local', yolo: true }],
  ] as const)('returns 400 when %s', async (_label, projectId, body) => {
    await createProject(projectId);
    const response = await addAgent(projectId, body);
    expect(response.statusCode).toBe(400);
  });

  it('returns 500 when no config path is configured', async () => {
    app.ctx.configPath = undefined;
    const response = await addAgent('proj', devAgent('nc-dev'));
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toMatch(/No config path/);
  });

  it('returns 400 for a whitespace-only agent id', async () => {
    await createProject('pid');
    const response = await addAgent('pid', devAgent('   '));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/agent id is required/);
  });

  it('returns 400 instead of 500 for a malformed Workdir value', async () => {
    await createProject('bad-wd');

    const response = await addAgent('bad-wd', devAgent('bad-wd-dev', {
      workdir: { path: '/tmp/not-a-string' },
    }));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('Invalid config');
  });

  it('returns 409 when another agent on the same host already uses the normalized Workdir', async () => {
    await createProject('shared-wd');
    expect((await addAgent('shared-wd', devAgent('shared-wd-1', {
      workdir: '/tmp/baxian-shared',
    }))).statusCode).toBe(201);

    const response = await addAgent('shared-wd', devAgent('shared-wd-2', {
      workdir: '/tmp/other/../baxian-shared',
    }));

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/must not share a directory/);
  });

  it('returns 409 when omitted and explicit default SSH ports share a Workdir', async () => {
    await createProject('shared-ssh-wd');
    expect((await addAgent('shared-ssh-wd', devAgent('shared-ssh-wd-1', {
      mode: 'remote',
      host: { hostname: 'box.example.com', user: 'git' },
      workdir: '/srv/baxian-shared',
    }))).statusCode).toBe(201);

    const response = await addAgent('shared-ssh-wd', devAgent('shared-ssh-wd-2', {
      mode: 'remote',
      host: { hostname: 'box.example.com', user: 'git', port: 22 },
      workdir: '/srv/baxian-shared',
    }));

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/must not share a directory/);
  });

  it('returns 409 when distinct SSH ports still share a host account and Workdir', async () => {
    await createProject('shared-port-wd');
    expect((await addAgent('shared-port-wd', devAgent('shared-port-wd-1', {
      mode: 'remote',
      host: { hostname: 'box.example.com', user: 'git', port: 22 },
      workdir: '/srv/baxian-shared',
    }))).statusCode).toBe(201);

    const response = await addAgent('shared-port-wd', devAgent('shared-port-wd-2', {
      mode: 'remote',
      host: { hostname: 'box.example.com', user: 'git', port: 2222 },
      workdir: '/srv/baxian-shared',
    }));

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/must not share a directory/);
  });

  it('returns semantic 409 when a yolo-disabled agent reuses the root Workdir', async () => {
    for (const project of app.ctx.config.project) {
      for (const agent of project.agent.flat()) agent.yolo = false;
    }
    app.ctx.config.root = {
      runtime: 'codex',
      mode: 'local',
      workdir: '/tmp/root-shared',
      responseTimeoutMinutes: 15,
    };
    await createProject('shared-root-wd');

    const response = await addAgent('shared-root-wd', devAgent('shared-root-wd-dev', {
      workdir: '/tmp/root-shared',
      yolo: false,
    }));

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/root-agent.*must not share a directory/);
  });

  it('returns 409 when pairWith dev is still being created (creationToken set)', async () => {
    await projectWithDev('qc', 'qc-dev');
    await seedAgent('qc-dev', 'qc', { creationToken: 'tok-mid-bootstrap' });
    const response = await addAgent('qc', qaAgent('qc-qa', 'qc-dev'));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/being created/);
    expect(findProject('qc').agent[0]).toHaveLength(1);
  });

  it('returns 400 when role=dev is sent with pairWith', async () => {
    await projectWithDev('pdp', 'pdp-dev');
    const response = await addAgent('pdp', devAgent('pdp-dev2', { pairWith: 'pdp-dev' }));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/pairWith is only valid for qa or research agents/);
  });

  it('adding a qa leaves unrelated pairs untouched (multi-pair project)', async () => {
    await createProject('mp');
    await addAgent('mp', devAgent('mp-dev1'));
    await addAgent('mp', devAgent('mp-dev2'));
    const response = await addAgent('mp', qaAgent('mp-qa', 'mp-dev1'));
    expect(response.statusCode).toBe(201);
    const proj = findProject('mp');
    expect(proj.agent).toEqual([
      [expect.objectContaining({ id: 'mp-dev1' }), expect.objectContaining({ id: 'mp-qa' })],
      [expect.objectContaining({ id: 'mp-dev2' })],
    ]);
  });

  it('rethrows non-validation prepareConfig failures as 500 (agent not committed)', async () => {
    await createProject('pboom');
    vi.spyOn(loaderModule, 'prepareConfig').mockImplementation(() => {
      throw new Error('kaboom');
    });
    const response = await addAgent('pboom', devAgent('pboom-dev'));
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('internal_error');
    expect(findProject('pboom').agent).toEqual([]);
    expect(await app.ctx.agentStore.get('pboom-dev')).toBeNull();
  });

  it('startBootstrapAsync rejection is logged as impossible; the 201 response is unaffected', async () => {
    await createProject('sba');
    const logSpy = vi.spyOn(app.log, 'error');
    vi.spyOn(app.ctx.agentManager, 'startBootstrapAsync').mockImplementation(async (agentId) => {
      const state = await app.ctx.agentStore.get(agentId);
      if (state) await app.ctx.agentStore.set({ ...state, creationToken: undefined, updatedAt: now() });
      throw new Error('impossible failure');
    });

    const response = await addAgent('sba', devAgent('sba-dev'));

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).runtimeStatus).toBe('pending');
    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'sba-dev' }),
        expect.stringContaining('startBootstrapAsync threw'),
      );
    });
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
    const purgeAgent = vi.fn().mockResolvedValue({ removed: 1 });
    app.ctx.errorRecordStore = { purgeAgent } as never;
    await projectWithDev('purge1', 'purge1-dev');
    await del('/api/projects/purge1/agents/purge1-dev');
    expect(purgeAgent).toHaveBeenCalledWith('purge1-dev');
  });

  it('clears the deleted agent\'s pet assignment (so a recreate with same id starts clean)', async () => {
    await projectWithDev('petdel', 'petdel-dev');
    const pet = await app.ctx.petStore!.create({
      displayName: 'P', description: '', spritesheet: { bytes: Buffer.from('x'), ext: 'webp' },
    });
    await app.ctx.petStore!.setAssignment('petdel-dev', pet.id);
    await del('/api/projects/petdel/agents/petdel-dev');
    expect(await app.ctx.petStore!.getAssignment('petdel-dev')).toBeNull();
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
    await projectWithDev('da-dup', 'da-dup-dev');
    await seedAgent('da-dup-dev', 'da-dup', {
      paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });

    let resolveCleanup: () => void = () => undefined;
    const cleanupGate = new Promise<void>((resolve) => { resolveCleanup = resolve; });
    const cleanupSpy = vi.spyOn(app.ctx.agentManager, 'cleanupRemovedAgentRuntime')
      .mockImplementation(async () => { await cleanupGate; });

    const first = del('/api/projects/da-dup/agents/da-dup-dev');
    await new Promise((r) => setTimeout(r, 20));
    const second = await del('/api/projects/da-dup/agents/da-dup-dev');

    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error).toMatch(/deletion already in progress/);

    resolveCleanup();
    const firstResp = await first;
    expect(firstResp.statusCode).toBe(200);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('concurrent DELETE + PUT pet: PUT is 409 while deletion is in flight, no stale assignment', async () => {
    await projectWithDev('da-petrace', 'da-petrace-dev');
    await seedAgent('da-petrace-dev', 'da-petrace', {
      paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    const pet = await app.ctx.petStore!.create({
      displayName: 'P', description: '', spritesheet: { bytes: Buffer.from('x'), ext: 'webp' },
    });

    let resolveCleanup: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { resolveCleanup = resolve; });
    vi.spyOn(app.ctx.agentManager, 'cleanupRemovedAgentRuntime').mockImplementation(async () => { await gate; });

    const deleting = del('/api/projects/da-petrace/agents/da-petrace-dev');
    await new Promise((r) => setTimeout(r, 20));
    const putResp = await put('/api/agents/da-petrace-dev/pet', { petId: pet.id });
    expect(putResp.statusCode).toBe(409);

    resolveCleanup();
    expect((await deleting).statusCode).toBe(200);
    expect(await app.ctx.petStore!.getAssignment('da-petrace-dev')).toBeNull();
  });

  it('awaiting_human with a foreign lock: DELETE refuses to steal ownership', async () => {
    await projectWithDev('da-stale', 'da-stale-dev');
    await seedAgent('da-stale-dev', 'da-stale', {
      paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    await app.ctx.lockManager.acquire('da-stale-dev', 'test:foreign');

    const response = await del('/api/projects/da-stale/agents/da-stale-dev');
    expect(response.statusCode).toBe(409);
    expect(await app.ctx.lockManager.isLocked('da-stale-dev')).toBe(true);
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
      taskId: 'task-mr-reserved', paneId: '%0', status: 'waiting', workdir: '/tmp/wt',
    });

    const response = await del('/api/projects/da-mr-active/agents/da-mr-active-dev');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/cancel the task before deleting/);
  });

  it('refuses deleting an UNBOUND agent still referenced by an active task (spec max_rounds preferredAgentId)', async () => {
    await projectWithDev('da-mr-ref', 'da-mr-ref-dev');
    await seedTask('task-spec-mr-ref', 'da-mr-ref', {
      preferredAgentId: 'da-mr-ref-dev', agentId: '', reviewRound: 5,
      status: 'max_rounds', phase: 'spec', prNumber: 8, branch: 'bx/task-spec-mr-ref',
    });
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

  it('deletes a terminal task binding after acquiring its missing exact task lock', async () => {
    await projectWithDev('da-terminal-binding', 'da-terminal-dev');
    await seedTask('task-terminal-binding', 'da-terminal-binding', {
      preferredAgentId: 'da-terminal-dev',
      agentId: 'da-terminal-dev',
      status: 'cancelled',
      branch: 'bx/task-terminal-binding',
    });
    await seedAgent('da-terminal-dev', 'da-terminal-binding', {
      taskId: 'task-terminal-binding',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
      workdir: '/tmp/da-terminal-dev',
    });

    const response = await del('/api/projects/da-terminal-binding/agents/da-terminal-dev');

    expect(response.statusCode).toBe(200);
    expect(await app.ctx.lockManager.isLocked('da-terminal-dev')).toBe(false);
    expect(await app.ctx.agentStore.get('da-terminal-dev')).toBeNull();
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

  it('Phase 3 saveConfig fails → 500 + rollbackPerTargetState + acquired lock released for clean retry', async () => {
    await projectWithDev('da-rb', 'da-rb-dev');
    await seedAgent('da-rb-dev', 'da-rb', { paneId: '%0', workdir: '/tmp/repo' });

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

    // saveConfig fails BEFORE any state delete (reordered) → the agent state is fully intact, not restored.
    const stateAfter = await app.ctx.agentStore.get('da-rb-dev');
    expect(stateAfter?.paneId).toBe('%0');
    expect(stateAfter?.workdir).toBe('/tmp/repo');

    // This attempt's freshly-acquired delete-owner lock is released so a retry DELETE (unbound agent)
    // does not EEXIST-collide; the generation stays 0 (bumped only after commit) and tombstone cleared.
    expect(await app.ctx.lockManager.claimOf('da-rb-dev')).toBeNull();
    expect(app.ctx.agentManager.deletionGenerationOf('da-rb-dev')).toBe(0);
    expect(app.ctx.agentManager.isDeletionInFlight('da-rb-dev')).toBe(false);
  });

  it('returns 500 when no config path is configured', async () => {
    app.ctx.configPath = undefined;
    const response = await del('/api/projects/proj/agents/dev-1');
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toMatch(/No config path/);
  });

  it('refuses when an active task references the agent via agentId only (agent itself unbound)', async () => {
    await projectWithDev('ref-a', 'ref-a-dev');
    await seedAgent('ref-a-dev', 'ref-a', { status: 'idle' });
    await seedTask('task-ref-a', 'ref-a', { preferredAgentId: '', agentId: 'ref-a-dev', status: 'in_progress' });

    const response = await del('/api/projects/ref-a/agents/ref-a-dev');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/referenced by active task task-ref-a/);
    expect(findProject('ref-a').agent[0][0].id).toBe('ref-a-dev');
  });

  it('refuses deleting a qa referenced via qaAgentId by an active task', async () => {
    await projectWithDev('ref-q', 'ref-q-dev');
    await addAgent('ref-q', qaAgent('ref-q-qa', 'ref-q-dev'));
    await seedTask('task-ref-q', 'ref-q', {
      preferredAgentId: '', agentId: '', qaAgentId: 'ref-q-qa', status: 'review',
    });

    const response = await del('/api/projects/ref-q/agents/ref-q-qa');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/referenced by active task task-ref-q/);
    expect(findProject('ref-q').agent[0]).toHaveLength(2);
  });

  it('refuses deleting an unbound Dev referenced only via devAgentId by an active task', async () => {
    await projectWithDev('ref-d', 'ref-d-dev');
    await seedAgent('ref-d-dev', 'ref-d', { status: 'idle' });
    await seedTask('task-ref-d', 'ref-d', {
      preferredAgentId: '',
      agentId: '',
      devAgentId: 'ref-d-dev',
      status: 'in_progress',
    });

    const response = await del('/api/projects/ref-d/agents/ref-d-dev');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/referenced by active task task-ref-d/);
    expect(findProject('ref-d').agent[0][0].id).toBe('ref-d-dev');
  });

  it('refuses deleting an unbound Research referenced via researchAgentId by an active code task', async () => {
    await projectWithDev('ref-r', 'ref-r-dev');
    await addAgent('ref-r', researchAgent('ref-r-research', 'ref-r-dev'));
    await seedAgent('ref-r-research', 'ref-r', { status: 'idle' });
    await seedTask('task-ref-r', 'ref-r', {
      preferredAgentId: 'ref-r-research',
      agentId: 'ref-r-dev',
      devAgentId: 'ref-r-dev',
      researchAgentId: 'ref-r-research',
      phase: 'code',
      status: 'in_progress',
    });

    const response = await del('/api/projects/ref-r/agents/ref-r-research');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/referenced by active task task-ref-r/);
    expect(findProject('ref-r').agent[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ref-r-dev' }),
      expect.objectContaining({ id: 'ref-r-research' }),
    ]));
  });

  it('409 when a non-awaiting agent is locked by another op', async () => {
    await projectWithDev('lk1', 'lk1-dev');
    await seedAgent('lk1-dev', 'lk1', { status: 'idle' });
    const token = await app.ctx.lockManager.acquire('lk1-dev', 'test:foreign');

    const response = await del('/api/projects/lk1/agents/lk1-dev');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/locked by another op/);
    expect(findProject('lk1').agent[0][0].id).toBe('lk1-dev');
    await app.ctx.lockManager.releaseIfOwner('lk1-dev', 'test:foreign', token!);
  });

  it('releases locks it already acquired when a later pair member is locked', async () => {
    await projectWithDev('lk2', 'lk2-dev');
    await addAgent('lk2', qaAgent('lk2-qa', 'lk2-dev'));
    await seedAgent('lk2-qa', 'lk2', { status: 'idle' });
    const token = await app.ctx.lockManager.acquire('lk2-qa', 'test:foreign');

    const response = await del('/api/projects/lk2/agents/lk2-dev');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/locked by another op/);
    expect(await app.ctx.lockManager.isLocked('lk2-dev')).toBe(false);
    expect(await app.ctx.lockManager.isLocked('lk2-qa')).toBe(true);
    await app.ctx.lockManager.releaseIfOwner('lk2-qa', 'test:foreign', token!);
  });

  it('phase1 prepareConfig validation failure → 400 Invalid config + locks released', async () => {
    await projectWithDev('v1', 'v1-dev');
    vi.spyOn(loaderModule, 'prepareConfig').mockImplementation(() => {
      throw new ConfigValidationError([{ path: 'project', message: 'bad' }]);
    });

    const response = await del('/api/projects/v1/agents/v1-dev');
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid config');
    expect(body.details).toEqual([{ path: 'project', message: 'bad' }]);
    expect(await app.ctx.lockManager.isLocked('v1-dev')).toBe(false);
    expect(findProject('v1').agent.flat().map(a => a.id)).toEqual(['v1-dev']);
  });

  it('phase1 prepareConfig unknown failure → 500 internal_error + locks released', async () => {
    await projectWithDev('v1b', 'v1b-dev');
    vi.spyOn(loaderModule, 'prepareConfig').mockImplementation(() => {
      throw new Error('kaboom');
    });

    const response = await del('/api/projects/v1b/agents/v1b-dev');
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('internal_error');
    expect(await app.ctx.lockManager.isLocked('v1b-dev')).toBe(false);
    expect(findProject('v1b').agent.flat().map(a => a.id)).toEqual(['v1b-dev']);
  });

  it('phase3 prepareConfig validation failure → 400 + state rollback + lock released', async () => {
    await projectWithDev('v3', 'v3-dev');
    await seedAgent('v3-dev', 'v3', { paneId: '%9', workdir: '/tmp/repo3' });
    const realPrepare = loaderModule.prepareConfig;
    let call = 0;
    vi.spyOn(loaderModule, 'prepareConfig').mockImplementation((raw) => {
      call += 1;
      if (call === 2) throw new ConfigValidationError([{ path: 'project', message: 'phase3 bad' }]);
      return realPrepare(raw);
    });

    const response = await del('/api/projects/v3/agents/v3-dev');
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('Invalid config');
    const state = await app.ctx.agentStore.get('v3-dev');
    expect(state?.paneId).toBeUndefined();
    expect(state?.workdir).toBe('/tmp/repo3');
    expect(await app.ctx.lockManager.isLocked('v3-dev')).toBe(false);
    expect(findProject('v3').agent.flat().map(a => a.id)).toEqual(['v3-dev']);
  });

  it('phase3 prepareConfig unknown failure → 500 internal_error after rollback', async () => {
    await projectWithDev('v3b', 'v3b-dev');
    const realPrepare = loaderModule.prepareConfig;
    let call = 0;
    vi.spyOn(loaderModule, 'prepareConfig').mockImplementation((raw) => {
      call += 1;
      if (call === 2) throw new Error('phase3 kaboom');
      return realPrepare(raw);
    });

    const response = await del('/api/projects/v3b/agents/v3b-dev');
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('internal_error');
    expect(await app.ctx.lockManager.isLocked('v3b-dev')).toBe(false);
    expect(findProject('v3b').agent.flat().map(a => a.id)).toEqual(['v3b-dev']);
  });

  it('runtime cleanup CleanupFailedError → 502 + failures payload + state rollback, config intact', async () => {
    await projectWithDev('cf1', 'cf1-dev');
    await seedAgent('cf1-dev', 'cf1', { paneId: '%3', workdir: '/tmp/r' });
    vi.spyOn(app.ctx.agentManager, 'cleanupRemovedAgentRuntime').mockRejectedValue(
      new CleanupFailedError('cleanup failed', [
        { agentId: 'cf1-dev', step: 'kill-session', error: new Error('ssh down') },
        { agentId: 'cf1-dev', step: 'worktree', error: 'raw failure string' },
      ]),
    );

    const response = await del('/api/projects/cf1/agents/cf1-dev');
    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/runtime cleanup failed for cf1-dev/);
    expect(body.failures).toEqual([
      { agentId: 'cf1-dev', step: 'kill-session', error: 'ssh down' },
      { agentId: 'cf1-dev', step: 'worktree', error: 'raw failure string' },
    ]);
    expect(findProject('cf1').agent.flat().map(a => a.id)).toEqual(['cf1-dev']);
    const state = await app.ctx.agentStore.get('cf1-dev');
    expect(state?.paneId).toBeUndefined();
    expect(state?.workdir).toBe('/tmp/r');
    expect(await app.ctx.lockManager.isLocked('cf1-dev')).toBe(false);
  });

  it('unrecognised runtime cleanup error → 502 with config and agent state preserved', async () => {
    await projectWithDev('cf2', 'cf2-dev');
    await seedAgent('cf2-dev', 'cf2', { paneId: '%4' });
    vi.spyOn(app.ctx.agentManager, 'cleanupRemovedAgentRuntime').mockRejectedValue(new Error('flaky ssh'));

    const response = await del('/api/projects/cf2/agents/cf2-dev');
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).failures).toEqual([
      { agentId: 'cf2-dev', step: 'runtime.cleanup', error: 'flaky ssh' },
    ]);
    expect(findProject('cf2').agent.flat().map(agent => agent.id)).toEqual(['cf2-dev']);
    expect(await app.ctx.agentStore.get('cf2-dev')).toMatchObject({ id: 'cf2-dev', projectId: 'cf2' });
  });

  it('claim rotation: a delayed old-owner release cannot free the lock mid-DELETE; rollback restores it', async () => {
    await projectWithDev('cf-lock', 'cf-lock-dev');
    await seedTask('cf-lock-task', 'cf-lock', {
      agentId: 'cf-lock-dev', preferredAgentId: 'cf-lock-dev', status: 'failed',
    });
    const oldToken = await app.ctx.lockManager.acquire('cf-lock-dev', 'cf-lock-task');
    await seedAgent('cf-lock-dev', 'cf-lock', {
      taskId: 'cf-lock-task', lockToken: oldToken!, paneId: '%5',
    });
    let releaseReturnedTrue: boolean | null = null;
    vi.spyOn(app.ctx.agentManager, 'cleanupRemovedAgentRuntime').mockImplementation(async () => {
      // Phase 1 already rotated the claim onto the deletion owner, so this stale-token release is a
      // harmless no-op (the shared-token race is closed) — it must NOT free the lock file.
      releaseReturnedTrue = await app.ctx.lockManager.releaseIfOwner('cf-lock-dev', 'cf-lock-task', oldToken!);
      await app.ctx.agentStore.update('cf-lock-dev', state => ({
        ...state!, taskId: undefined, lockToken: undefined, updatedAt: now(),
      }));
      throw new CleanupFailedError('cleanup failed', [
        { agentId: 'cf-lock-dev', step: 'tmux', error: new Error('ssh down') },
      ]);
    });

    const response = await del('/api/projects/cf-lock/agents/cf-lock-dev');

    expect(response.statusCode).toBe(502);
    expect(releaseReturnedTrue).toBe(false);
    const restored = (await app.ctx.agentStore.get('cf-lock-dev'))!;
    expect(restored.taskId).toBe('cf-lock-task');
    // Rollback rotates the claim back to the original owner, so the original token is valid again.
    expect(restored.lockToken).toBe(oldToken);
    expect(await app.ctx.lockManager.isOwner('cf-lock-dev', 'cf-lock-task', oldToken!)).toBe(true);
  });

  it('claim rotation rollback re-derives a drifted state.lockToken from the live claim', async () => {
    // The recorded state.lockToken drifted from the lock file's actual token (same task). Rotation
    // rotates off the REAL token; on rollback, rollbackPerTargetState re-derives the token from the
    // restored claim (claim.taskId === original.taskId ⟹ lockToken = claim.token), so the binding
    // is releasable regardless of the drifted seed. Guards against a stuck, unreleasable binding.
    await projectWithDev('cf-drift', 'cf-drift-dev');
    await seedTask('cf-drift-task', 'cf-drift', {
      agentId: 'cf-drift-dev', preferredAgentId: 'cf-drift-dev', status: 'failed',
    });
    const realToken = await app.ctx.lockManager.acquire('cf-drift-dev', 'cf-drift-task');
    await seedAgent('cf-drift-dev', 'cf-drift', {
      taskId: 'cf-drift-task', lockToken: 'drifted-stale-token', paneId: '%6',
    });
    vi.spyOn(app.ctx.agentManager, 'cleanupRemovedAgentRuntime').mockRejectedValue(
      new CleanupFailedError('cleanup failed', [
        { agentId: 'cf-drift-dev', step: 'tmux', error: new Error('ssh down') },
      ]),
    );

    const response = await del('/api/projects/cf-drift/agents/cf-drift-dev');

    expect(response.statusCode).toBe(502);
    const restored = (await app.ctx.agentStore.get('cf-drift-dev'))!;
    expect(restored.taskId).toBe('cf-drift-task');
    expect(restored.lockToken).toBe(realToken);
    expect(restored.lockToken).not.toBe('drifted-stale-token');
    expect(await app.ctx.lockManager.isOwner('cf-drift-dev', 'cf-drift-task', realToken!)).toBe(true);
    // End-to-end: the binding is releasable again (drift fix means resolveTaskLockToken finds the token).
    expect(await app.ctx.agentManager.releaseAgentForTask('cf-drift-dev', 'cf-drift-task', 'idle')).toBe(true);
    expect(await app.ctx.lockManager.isLocked('cf-drift-dev')).toBe(false);
  });

  it('DELETE pre-commit throw after rotating one target rolls the original owners back (not release)', async () => {
    await createProject('cf-rb');
    await addAgent('cf-rb', devAgent('cf-rb-dev'));
    await addAgent('cf-rb', qaAgent('cf-rb-qa', 'cf-rb-dev'));
    await seedTask('cf-rb-td', 'cf-rb', { agentId: 'cf-rb-dev', preferredAgentId: 'cf-rb-dev', status: 'failed' });
    await seedTask('cf-rb-tq', 'cf-rb', { agentId: 'cf-rb-qa', preferredAgentId: 'cf-rb-qa', status: 'failed' });
    const devToken = await app.ctx.lockManager.acquire('cf-rb-dev', 'cf-rb-td');
    const qaToken = await app.ctx.lockManager.acquire('cf-rb-qa', 'cf-rb-tq');
    await seedAgent('cf-rb-dev', 'cf-rb', { taskId: 'cf-rb-td', lockToken: devToken!, paneId: '%1' });
    await seedAgent('cf-rb-qa', 'cf-rb', { taskId: 'cf-rb-tq', lockToken: qaToken!, paneId: '%2' });

    // Rotation processes the sorted targets; throw on the SECOND target's claimOf, after the first rotated.
    let claimOfCalls = 0;
    const realClaimOf = app.ctx.lockManager.claimOf.bind(app.ctx.lockManager);
    vi.spyOn(app.ctx.lockManager, 'claimOf').mockImplementation(async (id: string) => {
      claimOfCalls += 1;
      if (claimOfCalls === 2) throw new Error('injected claimOf outage mid-rotation');
      return realClaimOf(id);
    });

    const response = await del('/api/projects/cf-rb/agents/cf-rb-dev');
    expect(response.statusCode).toBe(500);
    // Nothing committed: both agents still in config.
    expect(findProject('cf-rb').agent.flat().map(a => a.id).sort()).toEqual(['cf-rb-dev', 'cf-rb-qa']);
    // The already-rotated target's ORIGINAL owner is restored (rollback), not released to nobody.
    expect(await app.ctx.lockManager.isOwner('cf-rb-dev', 'cf-rb-td', devToken!)).toBe(true);
    expect(await app.ctx.lockManager.isOwner('cf-rb-qa', 'cf-rb-tq', qaToken!)).toBe(true);
  });

  it('DELETE rollback surfaces a failed lock restore instead of reporting success', async () => {
    await projectWithDev('cf-rbf', 'cf-rbf-dev');
    await seedTask('cf-rbf-t', 'cf-rbf', { agentId: 'cf-rbf-dev', preferredAgentId: 'cf-rbf-dev', status: 'failed' });
    const token = await app.ctx.lockManager.acquire('cf-rbf-dev', 'cf-rbf-t');
    await seedAgent('cf-rbf-dev', 'cf-rbf', { taskId: 'cf-rbf-t', lockToken: token!, paneId: '%1' });

    // Forward rotation (→ deletion owner) works; the rollback (→ original owner) reports false.
    const realRotate = app.ctx.lockManager.rotateClaim.bind(app.ctx.lockManager);
    vi.spyOn(app.ctx.lockManager, 'rotateClaim').mockImplementation(
      async (id: string, expected: unknown, to: { taskId: string; token: string }) => {
        if (typeof to.taskId === 'string' && to.taskId.startsWith('deletion:')) {
          return realRotate(id, expected as never, to);
        }
        return false;
      },
    );
    // Cleanup fails → triggers the rollback path, which now hits the false rotate-back.
    vi.spyOn(app.ctx.agentManager, 'cleanupRemovedAgentRuntime').mockRejectedValue(
      new CleanupFailedError('cleanup failed', [{ agentId: 'cf-rbf-dev', step: 'tmux', error: new Error('ssh down') }]),
    );

    const response = await del('/api/projects/cf-rbf/agents/cf-rbf-dev');
    // A failed restore is surfaced as an error, not silently reported as a clean rollback.
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toMatch(/could not be restored|rollback/i);
    // Config left intact (nothing committed).
    expect(findProject('cf-rbf').agent.flat().map(a => a.id)).toEqual(['cf-rbf-dev']);
  });

  it('config changed during cleanup → phase3 recomputes the removal from the fresh config', async () => {
    await projectWithDev('cc1', 'cc1-dev');
    vi.spyOn(app.ctx.agentManager, 'cleanupRemovedAgentRuntime').mockImplementation(async () => {
      app.ctx.config = {
        ...app.ctx.config,
        project: [...app.ctx.config.project, { id: 'concurrent', repo: 'x/y', merge: null, agent: [] }],
      };
    });

    const response = await del('/api/projects/cc1/agents/cc1-dev');
    expect(response.statusCode).toBe(200);
    expect(findProject('cc1').agent).toEqual([]);
    expect(app.ctx.config.project.some(p => p.id === 'concurrent')).toBe(true);
  });

  it('replaceConfig throwing AFTER the config commit fail-stops: the id stays tombstoned past the request (POST 409)', async () => {
    await projectWithDev('dv1', 'dv1-dev');
    // A post-commit in-memory switch failure is a program bug: the diverged id must keep returning 409
    // for re-introduction (POST /agents) even after the DELETE request's finally releases its claim.
    vi.spyOn(app.ctx.agentManager, 'replaceConfig').mockImplementationOnce(() => { throw new Error('memory switch boom'); });

    const del1 = await del('/api/projects/dv1/agents/dv1-dev');
    expect(del1.statusCode).toBe(200); // disk committed → deletion reported (with warnings)
    expect(JSON.parse(del1.body).warnings === undefined || Array.isArray(JSON.parse(del1.body).warnings)).toBe(true);

    // After the request fully returned, the tombstone persists (fail-stop) → recreate is refused.
    expect(app.ctx.agentManager.isDeletionInFlight('dv1-dev')).toBe(true);
    const recreate = await app.inject({
      method: 'POST', url: '/api/projects/dv1/agents',
      payload: { id: 'dv1-dev', runtime: 'claude-code', role: 'dev', mode: 'local' },
    });
    expect(recreate.statusCode).toBe(409);
    expect(JSON.parse(recreate.body).error).toMatch(/being deleted|diverged/);
  });

  it('post-commit best-effort cleanup failures (purge / pet unassign) do not block deletion', async () => {
    await projectWithDev('be1', 'be1-dev');
    app.ctx.errorRecordStore = { purgeAgent: vi.fn().mockRejectedValue(new Error('io')) } as never;
    vi.spyOn(app.ctx.petStore!, 'setAssignment').mockRejectedValue(new Error('io'));

    const response = await del('/api/projects/be1/agents/be1-dev');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.removed).toEqual(['be1-dev']);
    expect(body.warnings).toBeUndefined();
    expect(findProject('be1').agent).toEqual([]);
    expect(await app.ctx.lockManager.isLocked('be1-dev')).toBe(false);
  });

  it('post-commit agent-state delete failure → 200 + warning (config committed, reclaimable orphan state, lock released)', async () => {
    await projectWithDev('be2', 'be2-dev');
    vi.spyOn(app.ctx.agentStore, 'delete').mockRejectedValue(new Error('io'));

    const response = await del('/api/projects/be2/agents/be2-dev');

    // saveConfig commits FIRST (reorder); a post-commit state-delete failure is a surfaced warning, not a 502.
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.removed).toEqual(['be2-dev']);
    expect(body.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/agent be2-dev state delete failed post-commit/)]));
    // config committed: the agent row is gone from memory and disk.
    expect(findProject('be2').agent.flat().map(a => a.id)).toEqual([]);
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8')) as BaxianConfig;
    expect(onDisk.project.find(p => p.id === 'be2')!.agent.flat().map(a => a.id)).toEqual([]);
    // delete failed → reclaimable orphan state remains; deletion-owner lock released, generation bumped past commit.
    expect(await app.ctx.agentStore.get('be2-dev')).toMatchObject({ id: 'be2-dev', projectId: 'be2' });
    expect(await app.ctx.lockManager.claimOf('be2-dev')).toBeNull();
    expect(app.ctx.agentManager.deletionGenerationOf('be2-dev')).toBe(1);
    expect(app.ctx.agentManager.isDeletionInFlight('be2-dev')).toBe(false);
  });

  it('pair delete with a post-commit second state-delete failure → 200 + warning; first state gone, second orphaned', async () => {
    await projectWithDev('be3', 'be3-dev');
    await addAgent('be3', qaAgent('be3-qa', 'be3-dev'));
    await seedAgent('be3-dev', 'be3', { workdir: '/tmp/be3', paneId: '%7' });
    const realDelete = app.ctx.agentStore.delete.bind(app.ctx.agentStore);
    vi.spyOn(app.ctx.agentStore, 'delete').mockImplementation(async (id) => {
      if (id === 'be3-qa') throw new Error('io');
      return realDelete(id);
    });

    const response = await del('/api/projects/be3/agents/be3-dev');

    // Config commits both removals first; the be3-qa state-delete failure is a post-commit warning, not a 502.
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/agent be3-qa state delete failed post-commit/)]));
    expect(findProject('be3').agent.flat()).toHaveLength(0);
    // be3-dev delete succeeded (state gone); be3-qa delete failed (reclaimable orphan remains).
    expect(await app.ctx.agentStore.get('be3-dev')).toBeNull();
    expect(await app.ctx.agentStore.get('be3-qa')).not.toBeNull();
  });

  it('phase 3 commits the config BEFORE deleting agent state, then bumps the deletion generation', async () => {
    await projectWithDev('ord1', 'ord1-dev');
    const order: string[] = [];
    const realDelete = app.ctx.agentStore.delete.bind(app.ctx.agentStore);
    vi.spyOn(app.ctx.agentStore, 'delete').mockImplementation(async (id) => {
      order.push(`delete:${id}`);
      return realDelete(id);
    });
    const realSave = loaderModule.saveConfig;
    vi.spyOn(loaderModule, 'saveConfig').mockImplementation(async (path, config) => {
      order.push('saveConfig');
      return realSave(path, config);
    });

    const response = await del('/api/projects/ord1/agents/ord1-dev');

    expect(response.statusCode).toBe(200);
    expect(order).toEqual(['saveConfig', 'delete:ord1-dev']);
    expect(app.ctx.agentManager.deletionGenerationOf('ord1-dev')).toBe(1);
  });

  it('post-commit lock release failure → 200 with warnings[] (deletion committed, not rolled back)', async () => {
    await projectWithDev('wl1', 'wl1-dev');
    vi.spyOn(app.ctx.lockManager, 'releaseIfOwner').mockRejectedValue(new Error('lock fs io'));

    const response = await del('/api/projects/wl1/agents/wl1-dev');

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.removed).toEqual(['wl1-dev']);
    expect(body.warnings).toEqual([expect.stringMatching(/lock release for wl1-dev failed: lock fs io/)]);
    expect(findProject('wl1').agent).toEqual([]);
    expect(await app.ctx.agentStore.get('wl1-dev')).toBeNull();
    expect(await app.ctx.lockManager.isLocked('wl1-dev')).toBe(true);
  });

  it('saveConfig failure with no prior agent state → 500, config intact, deletion lock rolled back for retry', async () => {
    await projectWithDev('rb0', 'rb0-dev');
    await app.ctx.agentStore.delete('rb0-dev');
    const realSave = loaderModule.saveConfig;
    vi.spyOn(loaderModule, 'saveConfig').mockImplementation(async (path, config) => {
      const proj = config.project.find(p => p.id === 'rb0');
      if (proj && !proj.agent.flat().some(a => a.id === 'rb0-dev')) {
        throw new Error('disk full simulation');
      }
      return realSave(path, config);
    });

    const response = await del('/api/projects/rb0/agents/rb0-dev');
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toMatch(/failed to persist config/);
    expect(await app.ctx.agentStore.get('rb0-dev')).toBeNull();
    expect(findProject('rb0').agent.flat().map(a => a.id)).toEqual(['rb0-dev']);
    // freshly-acquired deletion-owner lock rolled back so a retry DELETE re-rotates cleanly (no EEXIST).
    expect(await app.ctx.lockManager.claimOf('rb0-dev')).toBeNull();
    expect(app.ctx.agentManager.deletionGenerationOf('rb0-dev')).toBe(0);
  });

  it('saveConfig failure never deletes agent state (reorder: state delete is strictly post-commit)', async () => {
    await projectWithDev('rb2', 'rb2-dev');
    await seedAgent('rb2-dev', 'rb2', { paneId: '%1' });
    const realSave = loaderModule.saveConfig;
    vi.spyOn(loaderModule, 'saveConfig').mockImplementation(async (path, config) => {
      const proj = config.project.find(p => p.id === 'rb2');
      if (proj && !proj.agent.flat().some(a => a.id === 'rb2-dev')) {
        throw new Error('disk full simulation');
      }
      return realSave(path, config);
    });
    const deleteSpy = vi.spyOn(app.ctx.agentStore, 'delete');

    const response = await del('/api/projects/rb2/agents/rb2-dev');
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toMatch(/failed to persist config/);
    // saveConfig is the commit point; a failure there must NOT have deleted state — no orphan, fully retry-able.
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await app.ctx.agentStore.get('rb2-dev')).toMatchObject({ id: 'rb2-dev', paneId: '%1' });
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

  it('resume surfaces the manager reason instead of the generic fallback (e.g. greeting_failed)', async () => {
    await seedAgent('dev-1', 'proj', { status: 'awaiting_human', awaitingPhase: 'greeting_failed' });
    vi.spyOn(app.ctx.agentManager, 'resumeAgent').mockResolvedValue({
      resumed: false,
      releasedBinding: false,
      reason: 'Greeting capability check failed; use Restart REPL to re-run the greeting check.',
    });

    const response = await post('/api/projects/proj/agents/dev-1/resume');

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/Restart REPL/);
    expect(body.error).not.toMatch(/not in a state that can be resumed/);
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
    await seedAgent('dev-1', 'proj', { status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    app.ctx.agentManager.tryClaimDeletion(['dev-1']);
    const resumeSpy = vi.spyOn(app.ctx.agentManager, 'resumeAgent');

    const response = await post('/api/projects/proj/agents/dev-1/resume');

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/being deleted/);
    expect(resumeSpy).not.toHaveBeenCalled();

    app.ctx.agentManager.releaseDeletionClaim(['dev-1']);
  });
});

describe('POST /api/projects/:projectId/agents/:agentId/restart-repl', () => {
  it('happy path: restartReplOnly invoked + 200', async () => {
    const restartSpy = vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    expect(restartSpy).toHaveBeenCalledWith('dev-1', { expectedGeneration: 0 });
  });

  it('restart-repl during DELETE (deletionInFlight): 409, restartReplOnly not invoked', async () => {
    app.ctx.agentManager.tryClaimDeletion(['dev-1']);
    const restartSpy = vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/being deleted/);
    expect(restartSpy).not.toHaveBeenCalled();

    app.ctx.agentManager.releaseDeletionClaim(['dev-1']);
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
    await app.ctx.lockManager.acquire('dev-1', 'task-tk1');
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
    await app.ctx.lockManager.acquire('dev-1', 'task-clear-held');
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    const state = await app.ctx.agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.awaitingReason).toBeUndefined();
    expect(state?.awaitingSince).toBeUndefined();
    expect(state?.taskId).toBe('task-clear-held');
  });

  it('restart-repl holds an unreplayable in-flight holder instead of downgrading it to waiting', async () => {
    await seedTask('task-hold-ctx', 'proj', {
      preferredAgentId: 'dev-1', status: 'fixing', branch: 'bx/task-hold-ctx',
    });
    await seedAgent('dev-1', 'proj', { taskId: 'task-hold-ctx', paneId: '%0' });
    await app.ctx.lockManager.acquire('dev-1', 'task-hold-ctx');
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    const state = await app.ctx.agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('restart-redispatch-failed');
  });

  it('restart-repl turns a redispatch failure into a resumable hold', async () => {
    await seedTask('task-redis-throw', 'proj', {
      preferredAgentId: 'dev-1', status: 'in_progress', branch: 'bx/task-redis-throw',
      signalToken: 'tok-throw',
    });
    await seedAgent('dev-1', 'proj', { taskId: 'task-redis-throw', paneId: '%0' });
    await app.ctx.lockManager.acquire('dev-1', 'task-redis-throw');
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();
    vi.spyOn(app.ctx.agentManager, 'redispatchTaskPromptAfterReplRestart')
      .mockRejectedValue(new Error('replay signal watcher failed to arm'));

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    const state = await app.ctx.agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('restart-redispatch-failed');
  });

  it('restart-repl waiting fallback preserves a hold that lands after every pre-read', async () => {
    await seedTask('task-race-hold', 'proj', {
      preferredAgentId: 'dev-1', status: 'in_progress', branch: 'bx/task-race-hold',
      signalToken: 'tok-race',
    });
    await seedAgent('dev-1', 'proj', { taskId: 'task-race-hold', paneId: '%0' });
    await app.ctx.lockManager.acquire('dev-1', 'task-race-hold');
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();
    let redispatched = false;
    vi.spyOn(app.ctx.agentManager, 'redispatchTaskPromptAfterReplRestart')
      .mockImplementation(async () => {
        redispatched = true;
        return false;
      });
    const realUpdate = app.ctx.agentStore.update.bind(app.ctx.agentStore);
    let injected = false;
    vi.spyOn(app.ctx.agentStore, 'update').mockImplementation(async (id, updater) => {
      // A recovery path writes an actionable hold between the fallback's reads and its atomic update.
      if (redispatched && !injected && id === 'dev-1') {
        injected = true;
        const cur = await app.ctx.agentStore.get('dev-1');
        await app.ctx.agentStore.set({
          ...cur!,
          status: 'awaiting_human',
          awaitingPhase: 'successor-pass-hold',
          awaitingReason: 'written after the fallback pre-reads',
          awaitingSince: now(),
          updatedAt: now(),
        });
      }
      return realUpdate(id, updater);
    });

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    const state = await app.ctx.agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('successor-pass-hold');
  });

  it('restart-repl does not hold a successor pass that rotated during the failed replay', async () => {
    await seedTask('task-redis-stale', 'proj', {
      preferredAgentId: 'dev-1', status: 'in_progress', branch: 'bx/task-redis-stale',
      signalToken: 'tok-entry',
    });
    await seedAgent('dev-1', 'proj', { taskId: 'task-redis-stale', paneId: '%0' });
    await app.ctx.lockManager.acquire('dev-1', 'task-redis-stale');
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();
    vi.spyOn(app.ctx.agentManager, 'redispatchTaskPromptAfterReplRestart')
      .mockImplementation(async () => {
        const fresh = await app.ctx.taskStore.get('task-redis-stale');
        await app.ctx.taskStore.set({ ...fresh!, signalToken: 'tok-successor' });
        throw new Error('enter scrub failed mid-delivery');
      });

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    const state = await app.ctx.agentStore.get('dev-1');
    expect(state?.status).not.toBe('awaiting_human');
    expect(state?.awaitingPhase).toBeUndefined();
  });

  it('restart-repl keeps a hold written by the failed replay delivery', async () => {
    await seedTask('task-fresh-hold', 'proj', {
      preferredAgentId: 'dev-1', status: 'in_progress', branch: 'bx/task-fresh-hold',
      signalToken: 'tok-fresh-hold',
    });
    await seedAgent('dev-1', 'proj', { taskId: 'task-fresh-hold', paneId: '%0' });
    await app.ctx.lockManager.acquire('dev-1', 'task-fresh-hold');
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();
    vi.spyOn(app.ctx.agentManager, 'redispatchTaskPromptAfterReplRestart')
      .mockImplementation(async (agentId) => {
        await app.ctx.agentManager.markAwaitingHuman(
          agentId,
          'workdir-changed-during-dispatch',
          'workdir moved mid-replay',
          { expectedTaskId: 'task-fresh-hold' },
        );
        return false;
      });

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    const state = await app.ctx.agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('workdir-changed-during-dispatch');
  });

  it('restart-repl keeps a replay hold rewritten with the same phase', async () => {
    await seedTask('task-rehold', 'proj', {
      preferredAgentId: 'dev-1', status: 'in_progress', branch: 'bx/task-rehold',
      signalToken: 'tok-rehold',
    });
    await seedAgent('dev-1', 'proj', {
      taskId: 'task-rehold', paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'workdir-changed-during-dispatch',
      awaitingReason: 'moved before restart',
      awaitingSince: '2026-07-01T00:00:00.000Z',
    });
    await app.ctx.lockManager.acquire('dev-1', 'task-rehold');
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();
    vi.spyOn(app.ctx.agentManager, 'redispatchTaskPromptAfterReplRestart')
      .mockImplementation(async (agentId) => {
        await app.ctx.agentManager.clearAwaitingHuman(agentId);
        await app.ctx.agentManager.markAwaitingHuman(
          agentId,
          'workdir-changed-during-dispatch',
          'moved again mid-replay',
          { expectedTaskId: 'task-rehold' },
        );
        return false;
      });

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    const state = await app.ctx.agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('workdir-changed-during-dispatch');
    expect(state?.awaitingReason).toBe('moved again mid-replay');
  });

  it('restart-repl keeps a replay hold rewritten with the same phase in the same millisecond', async () => {
    const frozen = '2026-07-01T00:00:00.000Z';
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(frozen) });
    try {
      await seedTask('task-rehold-ms', 'proj', {
        preferredAgentId: 'dev-1', status: 'in_progress', branch: 'bx/task-rehold-ms',
        signalToken: 'tok-rehold-ms',
      });
      await seedAgent('dev-1', 'proj', {
        taskId: 'task-rehold-ms', paneId: '%0',
        status: 'awaiting_human',
        awaitingPhase: 'workdir-changed-during-dispatch',
        awaitingReason: 'moved before restart',
        awaitingSince: frozen,
      });
      await app.ctx.lockManager.acquire('dev-1', 'task-rehold-ms');
      vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();
      vi.spyOn(app.ctx.agentManager, 'redispatchTaskPromptAfterReplRestart')
        .mockImplementation(async (agentId) => {
          await app.ctx.agentManager.clearAwaitingHuman(agentId);
          await app.ctx.agentManager.markAwaitingHuman(
            agentId,
            'workdir-changed-during-dispatch',
            'moved again mid-replay',
            { expectedTaskId: 'task-rehold-ms' },
          );
          return false;
        });

      const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

      expect(response.statusCode).toBe(200);
      const state = await app.ctx.agentStore.get('dev-1');
      expect(state?.status).toBe('awaiting_human');
      expect(state?.awaitingPhase).toBe('workdir-changed-during-dispatch');
      expect(state?.awaitingReason).toBe('moved again mid-replay');
      expect(state?.awaitingSince).toBe(frozen);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restart-repl clears awaiting_human Held state when no task is bound', async () => {
    await seedAgent('dev-1', 'proj', {
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'startup dialog',
      awaitingSince: now(),
    });
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    const state = await app.ctx.agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.awaitingReason).toBeUndefined();
    expect(state?.awaitingSince).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await app.ctx.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('restart-repl replaces a stale token before releasing a terminal task binding', async () => {
    await seedTask('task-terminal-restart', 'proj', {
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      status: 'merged',
      branch: 'bx/task-terminal-restart',
    });
    await seedAgent('dev-1', 'proj', {
      taskId: 'task-terminal-restart',
      lockToken: 'stale-generation',
      paneId: '%0',
    });
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    expect((await app.ctx.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await app.ctx.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('restart-repl reuses an existing exact lock for a terminal task binding', async () => {
    await seedTask('task-terminal-locked', 'proj', {
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      status: 'merged',
      branch: 'bx/task-terminal-locked',
    });
    const token = await app.ctx.lockManager.acquire('dev-1', 'task-terminal-locked');
    await seedAgent('dev-1', 'proj', {
      taskId: 'task-terminal-locked',
      lockToken: token!,
      paneId: '%0',
    });
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    expect((await app.ctx.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await app.ctx.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('restart-repl preserves a reused terminal-task lock when restart fails', async () => {
    await seedTask('task-terminal-restart-fails', 'proj', {
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      status: 'failed',
      branch: 'bx/task-terminal-restart-fails',
    });
    const token = await app.ctx.lockManager.acquire('dev-1', 'task-terminal-restart-fails');
    await seedAgent('dev-1', 'proj', {
      taskId: 'task-terminal-restart-fails',
      lockToken: token!,
      paneId: '%0',
    });
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockRejectedValue(new Error('restart failed'));

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(500);
    expect(await app.ctx.lockManager.isOwner(
      'dev-1', 'task-terminal-restart-fails', token!,
    )).toBe(true);
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

  it('qa bound to an active task (no takeover path) → 409, restart not attempted', async () => {
    await seedTask('task-qa-live', 'proj', {
      preferredAgentId: 'dev-1', agentId: 'dev-1', qaAgentId: 'qa-1', status: 'review',
    });
    await seedAgent('qa-1', 'proj', { taskId: 'task-qa-live' });
    const restartSpy = vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await post('/api/projects/proj/agents/qa-1/restart-repl');

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/bound to active task task-qa-live/);
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('idle agent locked by another op → 409', async () => {
    await seedAgent('dev-1', 'proj');
    await app.ctx.lockManager.acquire('dev-1', 'test:foreign');
    const restartSpy = vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/locked by another op/);
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('greeting_failed without a task → regreetHeldAgent instead of clearAwaitingHuman', async () => {
    await seedAgent('dev-1', 'proj', {
      paneId: '%0', status: 'awaiting_human', awaitingPhase: 'greeting_failed',
    });
    vi.spyOn(app.ctx.agentManager, 'restartReplOnly').mockResolvedValue();
    const regreetSpy = vi.spyOn(app.ctx.agentManager, 'regreetHeldAgent').mockResolvedValue(true);
    const clearSpy = vi.spyOn(app.ctx.agentManager, 'clearAwaitingHuman');

    const response = await post('/api/projects/proj/agents/dev-1/restart-repl');

    expect(response.statusCode).toBe(200);
    expect(regreetSpy).toHaveBeenCalledWith('dev-1');
    expect(clearSpy).not.toHaveBeenCalled();
    expect(await app.ctx.lockManager.isLocked('dev-1')).toBe(false);
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

  it('releases a stale QA binding with the same generation token used for recovery', async () => {
    await seedAgent('qa-1', 'proj', { taskId: 'task-gone' });
    app.ctx.tmuxSessionStatusStore.set('qa-1', { tmuxSessionStatus: 'absent' });

    const response = await post('/api/projects/proj/agents/qa-1/retry');

    expect(response.statusCode).toBe(200);
    expect((await app.ctx.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await app.ctx.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('retry reuses an existing exact lock and releases a terminal task binding', async () => {
    await seedTask('task-terminal-retry', 'proj', {
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      status: 'failed',
      branch: 'bx/task-terminal-retry',
    });
    const token = await app.ctx.lockManager.acquire('dev-1', 'task-terminal-retry');
    await seedAgent('dev-1', 'proj', {
      taskId: 'task-terminal-retry',
      lockToken: token!,
      paneId: '%old',
    });
    app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'absent' });

    const response = await post('/api/projects/proj/agents/dev-1/retry');

    expect(response.statusCode).toBe(200);
    expect((await app.ctx.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await app.ctx.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('retry clears stale awaiting_human Held state after ensureSession confirms REPL ready', async () => {
    await seedAgent('dev-1', 'proj', {
      paneId: '%old',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'startup dialog',
      awaitingSince: now(),
    });
    app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'absent' });

    const response = await post('/api/projects/proj/agents/dev-1/retry');

    expect(response.statusCode).toBe(200);
    const stateAfter = await app.ctx.agentStore.get('dev-1');
    expect(stateAfter?.paneId).toBe('%0');
    expect(stateAfter?.status).toBeUndefined();
    expect(stateAfter?.awaitingPhase).toBeUndefined();
    expect(stateAfter?.awaitingReason).toBeUndefined();
    expect(stateAfter?.awaitingSince).toBeUndefined();
  });

  it('retry fails closed (409) when a DELETE→recreate bumps the generation during ensureSession (no stale cleanup)', async () => {
    await seedAgent('dev-1', 'proj', {
      paneId: '%old',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'startup dialog',
      awaitingSince: now(),
    });
    app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'absent' });
    // ensureSession succeeds, but a concurrent DELETE→recreate bumps the generation during it, so the paneId
    // write no-ops. The endpoint must fail closed and NOT run the retry cleanup against the new incarnation.
    vi.spyOn(app.ctx.agentManager, 'ensureSession').mockImplementation(async (agentId) => {
      app.ctx.agentManager.bumpDeletionGeneration(agentId);
      return {
        ok: true, createdSession: true, paneId: '%0',
        pane: { session: { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' }, paneId: '%0', claim: agentId },
        workdir: '/tmp/test',
      };
    });

    const response = await post('/api/projects/proj/agents/dev-1/retry');

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/deleted or recreated during retry/);
    // The stale awaiting_human cleanup must NOT have run: the agent's state is left untouched.
    const stateAfter = await app.ctx.agentStore.get('dev-1');
    expect(stateAfter?.status).toBe('awaiting_human');
    expect(stateAfter?.awaitingPhase).toBe('agent_dialog_pending');
    expect(stateAfter?.paneId).toBe('%old');
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
    expect(handleSpy).toHaveBeenCalledWith(
      'dev-1',
      expect.any(EnsureSessionError),
      expect.objectContaining({ expectedGeneration: expect.any(Number) }),
    );
  });

  it('creationToken pending → 409 (operator-action hint, not 500)', async () => {
    await seedAgent('dev-1', 'proj', { creationToken: 'tok' });
    const response = await post('/api/projects/proj/agents/dev-1/retry');
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/being created/);
  });

  it('retry during DELETE (deletionInFlight): 409, ensureSession not invoked', async () => {
    app.ctx.agentManager.tryClaimDeletion(['dev-1']);

    const response = await post('/api/projects/proj/agents/dev-1/retry');

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/being deleted/);
    expect(vi.mocked(app.ctx.agentManager.ensureSession)).not.toHaveBeenCalled();

    app.ctx.agentManager.releaseDeletionClaim(['dev-1']);
  });

  it('returns 404 when agent is not in the project', async () => {
    const response = await post('/api/projects/no-such/agents/dev-1/retry');
    expect(response.statusCode).toBe(404);
  });

  it('locked by another op → 409', async () => {
    await seedAgent('dev-1', 'proj');
    app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'absent' });
    await app.ctx.lockManager.acquire('dev-1', 'test:foreign');

    const response = await post('/api/projects/proj/agents/dev-1/retry');
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/locked by another op/);
  });

  it('ensureSession failure after creating a session → rollback by ref + 500 + lock released', async () => {
    await seedAgent('dev-1', 'proj');
    app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'absent' });
    const REF = { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' };
    vi.spyOn(app.ctx.agentManager, 'ensureSession').mockRejectedValueOnce(
      new EnsureSessionError(
        { createdSession: true, agentId: 'dev-1', sessionRef: REF, genAtCreate: 0 },
        'repl never became ready',
      ),
    );
    vi.spyOn(app.ctx.agentManager, 'handleDialogPendingFromRuntime').mockResolvedValue(false);
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await post('/api/projects/proj/agents/dev-1/retry');

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('repl never became ready');
    expect(killSpy).toHaveBeenCalledWith(REF, { kind: 'emptyOr', claim: 'dev-1' });
    expect(await app.ctx.lockManager.isLocked('dev-1')).toBe(false);
    warn.mockRestore();
  });

  it('retry rollback stands down when the session was adopted after create', async () => {
    await seedAgent('dev-1', 'proj');
    app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'absent' });
    const mgr = app.ctx.agentManager as unknown as { adoptGeneration: Map<string, number> };
    vi.spyOn(app.ctx.agentManager, 'ensureSession').mockImplementationOnce(async () => {
      mgr.adoptGeneration.set('dev-1', (mgr.adoptGeneration.get('dev-1') ?? 0) + 1);
      throw new EnsureSessionError(
        {
          createdSession: true,
          agentId: 'dev-1',
          sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' },
          genAtCreate: mgr.adoptGeneration.get('dev-1')! - 1,
        },
        'repl never became ready',
      );
    });
    vi.spyOn(app.ctx.agentManager, 'handleDialogPendingFromRuntime').mockResolvedValue(false);
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await post('/api/projects/proj/agents/dev-1/retry');

    expect(response.statusCode).toBe(500);
    expect(killSpy).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(c => String(c[0]).includes('session adopted since create'))).toBe(true);
    warn.mockRestore();
  });

  it('rollback kill failure is swallowed with a warning; retry still returns 500', async () => {
    await seedAgent('dev-1', 'proj');
    app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'absent' });
    const REF = { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' };
    vi.spyOn(app.ctx.agentManager, 'ensureSession').mockRejectedValueOnce(
      new EnsureSessionError(
        { createdSession: true, agentId: 'dev-1', sessionRef: REF, genAtCreate: 0 },
        'repl never became ready',
      ),
    );
    vi.spyOn(app.ctx.agentManager, 'handleDialogPendingFromRuntime').mockResolvedValue(false);
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef')
      .mockRejectedValue(new Error('tmux server unreachable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await post('/api/projects/proj/agents/dev-1/retry');

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('repl never became ready');
    expect(killSpy).toHaveBeenCalledWith(REF, { kind: 'emptyOr', claim: 'dev-1' });
    expect(await app.ctx.lockManager.isLocked('dev-1')).toBe(false);
    warn.mockRestore();
  });
});

describe('POST /api/projects/:id/bootstrap', () => {
  it('returns 503 when bootstrapPoller is not initialised', async () => {
    const response = await post('/api/projects/proj/bootstrap');
    expect(response.statusCode).toBe(503);
  });

  it('returns 404 when pollProject reports knownProject=false (e.g. PATCH-then-restart race)', async () => {
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

  it('refuses to delete a project that still has platform-bound tasks, listing them', async () => {
    await createProject('locked');
    await app.ctx.taskStore.set({
      id: 'task-locked', projectId: 'locked', title: 'T', description: 'D', preferredAgentId: '', agentId: '', devAgentId: '',
      status: 'review', reviewMode: 'git', reviewRound: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);

    const response = await del('/api/projects/locked');

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.tasks).toEqual(['task-locked']);
    expect(body.details).toEqual([{
      path: 'project.locked',
      message: 'active platform-bound tasks prevent identity changes: task-locked',
    }]);
    expect(body.error).toMatch(/active platform-bound task/);
    expect(app.ctx.config.project.some(p => p.id === 'locked')).toBe(true);
  });

  it('refuses the delete for a server task that already bound its publish target', async () => {
    await createProject('locked-srv');
    await app.ctx.taskStore.set({
      id: 'task-srv', projectId: 'locked-srv', title: 'T', description: 'D', preferredAgentId: '', agentId: '', devAgentId: '',
      status: 'approved', reviewMode: 'server', afterDone: 'pr', reviewRound: 1,
      platformBinding: { mode: 'server', repoKey: 'github.com/a/b', tool: 'gh' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);

    const response = await del('/api/projects/locked-srv');

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).tasks).toEqual(['task-srv']);
  });

  it('allows the delete once the blocking task reaches a terminal status', async () => {
    await createProject('unlocks');
    const base = {
      id: 'task-unlocks', projectId: 'unlocks', title: 'T', description: 'D', preferredAgentId: '', agentId: '', devAgentId: '',
      reviewMode: 'git', reviewRound: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await app.ctx.taskStore.set({ ...base, status: 'review' } as never);
    expect((await del('/api/projects/unlocks')).statusCode).toBe(409);

    await app.ctx.taskStore.set({ ...base, status: 'merged' } as never);
    expect((await del('/api/projects/unlocks')).statusCode).toBe(200);
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

  it('returns 500 when no config path is configured', async () => {
    app.ctx.configPath = undefined;
    const response = await del('/api/projects/proj');
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toMatch(/No config path/);
  });

  it('maps prepareConfig validation failure to 400 Invalid config and keeps the project', async () => {
    await createProject('civ');
    vi.spyOn(loaderModule, 'prepareConfig').mockImplementation(() => {
      throw new ConfigValidationError([{ path: 'project', message: 'bad' }]);
    });

    const response = await del('/api/projects/civ');
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid config');
    expect(body.details).toEqual([{ path: 'project', message: 'bad' }]);
    expect(app.ctx.config.project.some(p => p.id === 'civ')).toBe(true);
  });

  it('rethrows unknown prepareConfig failures as 500 and keeps the project', async () => {
    await createProject('cboom');
    vi.spyOn(loaderModule, 'prepareConfig').mockImplementation(() => {
      throw new Error('kaboom');
    });

    const response = await del('/api/projects/cboom');
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('internal_error');
    expect(app.ctx.config.project.some(p => p.id === 'cboom')).toBe(true);
  });
});
