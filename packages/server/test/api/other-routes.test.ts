import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { BaxianConfig, BaxianEvent, ProjectConfig } from '../../src/shared/index.js';
import {
  requesters,
  seedConfigPath,
  setupApiHarness,
  teardownApiHarness,
  JSON_HEADERS,
  type ApiHarness,
} from './helpers.js';

let harness: ApiHarness;
let tempDir: string;
let app: FastifyInstance;
const { get, patch } = requesters(() => app);

beforeEach(async () => {
  harness = await setupApiHarness('other');
  ({ tempDir, app } = harness);
});

afterEach(() => teardownApiHarness(harness));

describe('GET /api/events', () => {
  it('returns events for today (default)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const event: BaxianEvent = {
      id: 'evt-test-001',
      type: 'task.assigned',
      timestamp: `${today}T10:00:00Z`,
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: 'task-001',
      data: {},
    };
    await app.ctx.eventLog.append(event);

    const response = await get('/api/events');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as BaxianEvent[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('evt-test-001');
  });

  it('returns events for a specific date', async () => {
    const date = '2025-01-15';
    const event: BaxianEvent = {
      id: 'evt-test-002',
      type: 'session.started',
      timestamp: `${date}T10:00:00Z`,
      projectId: 'proj',
      data: {},
    };
    await app.ctx.eventLog.append(event);

    const response = await get(`/api/events?date=${date}`);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as BaxianEvent[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('evt-test-002');
  });
});

describe('GET /api/config', () => {
  it('returns current config', async () => {
    const response = await get('/api/config');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as BaxianConfig;
    expect(body.server.port).toBe(3000);
    expect(body.project).toHaveLength(1);
  });

  it('redacts server.token when set', async () => {
    const token = 'super-secret-token';
    app.ctx.config = { ...app.ctx.config, server: { ...app.ctx.config.server, token } };
    const response = await get('/api/config', { headers: { Authorization: `Bearer ${token}` } });
    const body = JSON.parse(response.body) as BaxianConfig;
    expect(body.server.token).toBe('***');
  });

  it('redacts registry host passwords', async () => {
    app.ctx.config = { ...app.ctx.config, host: [{ id: 'box', hostname: 'h', password: 'reg-secret' }] };
    const response = await get('/api/config');
    const body = JSON.parse(response.body) as BaxianConfig;
    expect(body.host[0].password).toBe('***');
  });

  it('redacts a legacy inline agent.host password on GET /config and GET /projects', async () => {
    app.ctx.config = {
      ...app.ctx.config,
      project: [{
        id: 'proj', repo: 'user/repo', merge: null,
        agent: [[
          { id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: { hostname: 'legacy', password: 'inline-secret' } },
          { id: 'rqa', runtime: 'codex', role: 'qa', mode: 'remote', host: { hostname: 'legacy', password: 'inline-secret' } },
        ]],
      }],
    };
    const cfg = JSON.parse((await get('/api/config')).body) as BaxianConfig;
    expect((cfg.project[0].agent[0][0].host as { password?: string }).password).toBe('***');

    const projects = JSON.parse((await get('/api/projects')).body) as ProjectConfig[];
    expect((projects[0].agent[0][0].host as { password?: string }).password).toBe('***');
  });

});

describe('PATCH /api/config', () => {
  it('rejects the commit and keeps memory and disk config unchanged when the participant scan fails', async () => {
    const configPath = await seedConfigPath(app, tempDir);
    const memoryBefore = app.ctx.config;
    const diskBefore = await readFile(configPath, 'utf8');
    vi.spyOn(app.ctx.agentManager, 'listActiveParticipantSeats')
      .mockRejectedValue(new Error('task scan failed'));

    const response = await patch('/api/config', { review: { rounds: 3 } }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(500);
    expect(app.ctx.config).toBe(memoryBefore);
    expect(await readFile(configPath, 'utf8')).toBe(diskBefore);
  });

  it('returns blocking task ids in validation details for a platform identity conflict', async () => {
    await seedConfigPath(app, tempDir);
    vi.spyOn(app.ctx.agentManager, 'guardGitConfigCommit').mockResolvedValue({
      ok: false,
      blockers: [{ projectId: 'proj', taskIds: ['task-locked'] }],
    });

    const response = await patch('/api/config', { review: { rounds: 3 } }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      blockers: [{ projectId: 'proj', taskIds: ['task-locked'] }],
      details: [{
        path: 'project.proj',
        message: 'active platform-bound tasks prevent identity changes: task-locked',
      }],
    });
  });

  it('preserves existing server.token when client round-trips the redacted placeholder', async () => {
    const original = 'real-token-value';
    await seedConfigPath(app, tempDir);
    app.ctx.config = { ...app.ctx.config, server: { ...app.ctx.config.server, token: original } };

    const response = await patch('/api/config', { server: { port: 3000, token: '***' } }, {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${original}` },
    });
    expect(response.statusCode).toBe(200);
    expect(app.ctx.config.server.token).toBe(original);
  });

  it('clears server.token when client sends an explicit empty/whitespace value', async () => {
    const original = 'abc';
    await seedConfigPath(app, tempDir);
    app.ctx.config = { ...app.ctx.config, server: { ...app.ctx.config.server, token: original } };

    const response = await patch('/api/config', { server: { port: 3000, token: '   ' } }, {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${original}` },
    });
    expect(response.statusCode).toBe(200);
    expect(app.ctx.config.server.token).toBeUndefined();
  });

  it('returns unknown-key warnings while stripping the keys from memory and disk', async () => {
    const configPath = await seedConfigPath(app, tempDir);

    const response = await patch('/api/config', {
      obsolete: true,
      review: { rounds: 3, mode: 'server', afterDone: 'pr' },
    }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).warnings).toEqual(expect.arrayContaining([
      { path: 'obsolete', message: 'unknown configuration key; it will be ignored' },
      { path: 'review.mode', message: 'unknown configuration key; it will be ignored' },
      { path: 'review.afterDone', message: 'unknown configuration key; it will be ignored' },
    ]));
    expect(app.ctx.config.review).toEqual({ rounds: 3 });
    expect(app.ctx.config).not.toHaveProperty('obsolete');
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.review).toEqual({ rounds: 3 });
    expect(saved).not.toHaveProperty('obsolete');
  });

  it('rejects host edits via PATCH /config (registry is managed via /hosts) and preserves current.host', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.config = { ...app.ctx.config, host: [{ id: 'box', hostname: 'h', port: 22, password: 'real-secret' }] };

    for (const hostPayload of [
      [{ id: 'box', hostname: 'moved', port: 2222 }],
      [{ id: 'box', hostname: 'h', port: 22, password: '***' }],
      null,
      'oops',
      { id: 'x' },
    ]) {
      const response = await patch('/api/config', { host: hostPayload }, { headers: JSON_HEADERS });
      expect(response.statusCode, JSON.stringify(hostPayload)).toBe(400);
    }
    expect(app.ctx.config.host[0].hostname).toBe('h');
    expect(app.ctx.config.host[0].password).toBe('real-secret');
  });

  it('returns 400 (not 500) for a malformed project on PATCH /config (host-ref guard runs post-validation)', async () => {
    await seedConfigPath(app, tempDir);
    for (const bad of [
      { id: 'bad' },
      'oops',
      [{ id: 'pp', repo: 'u/r', merge: null, agent: { not: 'array' } }],
    ]) {
      const response = await patch('/api/config', { project: bad }, { headers: JSON_HEADERS });
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('rejects changing the host of a live agent via PATCH /config project replace (409)', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.config = {
      ...app.ctx.config,
      host: [{ id: 'box', hostname: 'h', port: 22 }, { id: 'box2', hostname: 'h2', port: 22 }],
      project: [{
        id: 'proj', repo: 'user/repo', merge: null,
        agent: [[
          { id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' },
          { id: 'rqa', runtime: 'codex', role: 'qa', mode: 'remote', host: 'box' },
        ]],
      }],
    };
    app.ctx.tmuxSessionStatusStore.set('rdev', { tmuxSessionStatus: 'present' });

    const response = await patch('/api/config', {
      project: [{
        id: 'proj', repo: 'user/repo', merge: null,
        agent: [[
          { id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box2' },
          { id: 'rqa', runtime: 'codex', role: 'qa', mode: 'remote', host: 'box' },
        ]],
      }],
    }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(409);
    expect((app.ctx.config.project[0].agent[0][0]).host).toBe('box');
  });

  it('rejects changing the Workdir of a task-bound agent and leaves memory and disk unchanged', async () => {
    const configPath = await seedConfigPath(app, tempDir);
    const currentWorkdir = app.ctx.config.project[0].agent[0][0].workdir!;
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      workdir: currentWorkdir,
      updatedAt: new Date().toISOString(),
    });
    const nextProjects = app.ctx.config.project.map(project => ({
      ...project,
      agent: project.agent.map(pair => pair.map(agent =>
        agent.id === 'dev-1' ? { ...agent, workdir: `${currentWorkdir}-new` } : agent)),
    }));

    const response = await patch('/api/config', { project: nextProjects }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/Workdir.*dev-1/i);
    expect(app.ctx.config.project[0].agent[0][0].workdir).toBe(currentWorkdir);
    expect(await readFile(configPath, 'utf8')).toBe('{}');
  });

  it.each([
    ['bootstrap', { creationToken: 'creating' }, false],
    ['persisted pane', { paneId: '%9' }, false],
    ['tmux session', {}, true],
  ])('rejects changing Workdir while the agent has a live %s fact', async (_label, facts, liveTmux) => {
    await seedConfigPath(app, tempDir);
    const currentWorkdir = app.ctx.config.project[0].agent[0][0].workdir!;
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      workdir: currentWorkdir,
      ...facts,
      updatedAt: new Date().toISOString(),
    });
    if (liveTmux) {
      app.ctx.tmuxSessionStatusStore.set('dev-1', { tmuxSessionStatus: 'present' });
    }
    const nextProjects = app.ctx.config.project.map(project => ({
      ...project,
      agent: project.agent.map(pair => pair.map(agent =>
        agent.id === 'dev-1' ? { ...agent, workdir: `${currentWorkdir}-new` } : agent)),
    }));

    const response = await patch('/api/config', { project: nextProjects }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(409);
    expect(app.ctx.config.project[0].agent[0][0].workdir).toBe(currentWorkdir);
  });

  it('rejects changing the Workdir of a live remote agent', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.config = {
      ...app.ctx.config,
      host: [{ id: 'box', hostname: 'remote.example', user: 'runner' }],
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [[{
          id: 'rdev',
          runtime: 'claude-code',
          role: 'dev',
          mode: 'remote',
          host: 'box',
          workdir: '/srv/repo',
        }, {
          id: 'rqa',
          runtime: 'codex',
          role: 'qa',
          mode: 'remote',
          host: 'box',
          workdir: '/srv/qa-repo',
        }]],
      }],
    };
    app.ctx.agentManager.replaceConfig(app.ctx.config);
    await app.ctx.agentStore.set({
      id: 'rdev',
      projectId: 'proj',
      taskId: 'task-remote',
      workdir: '/srv/repo',
      updatedAt: new Date().toISOString(),
    });
    const nextProjects = app.ctx.config.project.map(project => ({
      ...project,
      agent: project.agent.map(pair => pair.map(agent =>
        agent.id === 'rdev' ? { ...agent, workdir: '/srv/repo-new' } : agent)),
    }));

    const response = await patch('/api/config', { project: nextProjects }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(409);
    expect(app.ctx.config.project[0].agent[0][0].workdir).toBe('/srv/repo');
  });

  it('rejects removing addDirs from a live agent because its running process keeps the old grants', async () => {
    await seedConfigPath(app, tempDir);
    const oldAddDir = join(tempDir, 'root-mailbox-grant');
    app.ctx.config = {
      ...app.ctx.config,
      project: app.ctx.config.project.map(project => ({
        ...project,
        agent: project.agent.map(pair => pair.map(agent =>
          agent.id === 'dev-1' ? { ...agent, addDirs: [oldAddDir] } : agent)),
      })),
    };
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      updatedAt: new Date().toISOString(),
    });
    const nextProjects = app.ctx.config.project.map(project => ({
      ...project,
      agent: project.agent.map(pair => pair.map(agent =>
        agent.id === 'dev-1' ? { ...agent, addDirs: [] } : agent)),
    }));

    const response = await patch('/api/config', { project: nextProjects }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/permissions\/addDirs.*dev-1/);
    expect(app.ctx.config.project[0].agent[0][0].addDirs).toEqual([oldAddDir]);
  });

  it('rejects changing yolo while an agent is live', async () => {
    await seedConfigPath(app, tempDir);
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      updatedAt: new Date().toISOString(),
    });
    const nextProjects = app.ctx.config.project.map(project => ({
      ...project,
      agent: project.agent.map(pair => pair.map(agent =>
        agent.id === 'dev-1' ? { ...agent, yolo: false } : agent)),
    }));

    const response = await patch('/api/config', { project: nextProjects }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/permissions\/addDirs.*dev-1/);
    expect(app.ctx.config.project[0].agent[0][0].yolo).not.toBe(false);
  });

  it('allows addDirs changes after the agent is no longer live', async () => {
    await seedConfigPath(app, tempDir);
    const nextAddDir = join(tempDir, 'safe-extra');
    const nextProjects = app.ctx.config.project.map(project => ({
      ...project,
      agent: project.agent.map(pair => pair.map(agent =>
        agent.id === 'dev-1' ? { ...agent, addDirs: [nextAddDir] } : agent)),
    }));

    const response = await patch('/api/config', { project: nextProjects }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(200);
    expect(app.ctx.config.project[0].agent[0][0].addDirs).toEqual([nextAddDir]);
  });

  it('rejects removing a live agent through bulk config replacement', async () => {
    await seedConfigPath(app, tempDir);
    const currentProjects = app.ctx.config.project;
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      workdir: currentProjects[0].agent[0][0].workdir,
      updatedAt: new Date().toISOString(),
    });
    const nextProjects = currentProjects.map(project => ({
      ...project,
      agent: [],
    }));

    const response = await patch('/api/config', { project: nextProjects }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/configuration entry.*dev-1/i);
    expect(app.ctx.config.project[0].agent.flat().some(agent => agent.id === 'dev-1')).toBe(true);
  });

  it('rejects re-introducing an agent id whose DELETE is in flight (tombstone gate)', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.agentManager.tryClaimDeletion(['ghost-dev']);
    const nextProjects = app.ctx.config.project.map(project => ({
      ...project,
      agent: [
        ...project.agent,
        [
          { id: 'ghost-dev', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: join(tempDir, 'ghost-dev') },
          { id: 'ghost-qa', runtime: 'codex', role: 'qa', mode: 'local', workdir: join(tempDir, 'ghost-qa') },
        ],
      ],
    }));

    const response = await patch('/api/config', { project: nextProjects }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/being deleted.*cannot keep or \(re\)introduce/);
    expect(app.ctx.config.project[0].agent.flat().some(agent => agent.id === 'ghost-dev')).toBe(false);

    app.ctx.agentManager.releaseDeletionClaim(['ghost-dev']);
  });

  it('rejects MOVING an existing agent id whose DELETE is in flight to another project (tombstone bypass)', async () => {
    await seedConfigPath(app, tempDir);
    // dev-1 already exists in project 0; a concurrent DELETE holds its tombstone.
    const movingId = app.ctx.config.project[0].agent.flat()[0].id;
    app.ctx.agentManager.tryClaimDeletion([movingId]);
    // A PATCH that keeps the SAME id (host/workdir unchanged) but relocates it to another project must NOT
    // slip past the tombstone just because the id is still in the current config.
    const nextProjects = app.ctx.config.project.map((project, i) => ({
      ...project,
      id: i === 0 ? `${project.id}-moved` : project.id,
    }));

    const response = await patch('/api/config', { project: nextProjects }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/being deleted.*cannot keep/);

    app.ctx.agentManager.releaseDeletionClaim([movingId]);
  });

  it('allows an idle agent to change Workdir and releases only its old canonical owner claim', async () => {
    const configPath = await seedConfigPath(app, tempDir);
    const currentWorkdir = app.ctx.config.project[0].agent[0][0].workdir!;
    const nextWorkdir = `${currentWorkdir}-new`;
    await app.ctx.agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      workdir: currentWorkdir,
      updatedAt: new Date().toISOString(),
    });
    app.ctx.agentManager.getRepoCache().owners.set(`local:${currentWorkdir}`, 'dev-1');
    app.ctx.agentManager.getRepoCache().owners.set('local:/qa', 'qa-1');
    const nextProjects = app.ctx.config.project.map(project => ({
      ...project,
      agent: project.agent.map(pair => pair.map(agent =>
        agent.id === 'dev-1' ? { ...agent, workdir: nextWorkdir } : agent)),
    }));

    const response = await patch('/api/config', { project: nextProjects }, { headers: JSON_HEADERS });

    expect(response.statusCode).toBe(200);
    expect(app.ctx.config.project[0].agent[0][0].workdir).toBe(nextWorkdir);
    expect(app.ctx.agentManager.getConfig().project[0].agent[0][0].workdir).toBe(nextWorkdir);
    expect(app.ctx.agentManager.getRepoCache().owners.has(`local:${currentWorkdir}`)).toBe(false);
    expect(app.ctx.agentManager.getRepoCache().owners.get('local:/qa')).toBe('qa-1');
    expect(JSON.parse(await readFile(configPath, 'utf8')).project[0].agent[0][0].workdir).toBe(nextWorkdir);
  });

  it('rejects PATCH with out-of-range server.githubPollIntervalMs and preserves existing valid value', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.config = {
      ...app.ctx.config,
      server: { ...app.ctx.config.server, githubPollIntervalMs: 45000 },
    };

    for (const bad of [500, 1500.5, 2147483648]) {
      const response = await patch('/api/config', { server: { port: 3000, githubPollIntervalMs: bad } }, { headers: JSON_HEADERS });
      expect(response.statusCode).toBe(400);
      expect(app.ctx.config.server.githubPollIntervalMs).toBe(45000);
    }
  });

  it('accepts PATCH with valid server.githubPollIntervalMs and persists it', async () => {
    await seedConfigPath(app, tempDir);

    const response = await patch('/api/config', { server: { port: 3000, githubPollIntervalMs: 60000 } }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(200);
    expect(app.ctx.config.server.githubPollIntervalMs).toBe(60000);
  });

  it('rejects non-object JSON bodies (primitive / array) with 400, not 500', async () => {
    await seedConfigPath(app, tempDir);

    for (const value of ['x', 123, true, null, [1, 2, 3]]) {
      const response = await patch('/api/config', JSON.stringify(value), { headers: JSON_HEADERS });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as { error?: string };
      expect(body.error).toBe('Invalid config');
    }
  });

  it('sweeps errorRecordStore by new auto-bootstrap id set on bulk config replace', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.config = {
      ...app.ctx.config,
      project: [{
        id: 'p1', repo: 'a/b', merge: null,
        agent: [[
          { id: 'going-away', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
          { id: 'going-away-qa', runtime: 'codex', role: 'qa', mode: 'local', yolo: true },
        ]],
      }],
    };
    const sweepStaleBootstrapErrors = vi.fn().mockResolvedValue({ removed: 0 });
    app.ctx.errorRecordStore = { sweepStaleBootstrapErrors } as never;

    const response = await patch('/api/config', { project: [] }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(200);
    expect(sweepStaleBootstrapErrors).toHaveBeenCalledTimes(1);
    expect(sweepStaleBootstrapErrors.mock.calls[0][0].size).toBe(0);
  });

  it('sweep treats agent transitioned to explicit workdir as no longer in auto-bootstrap', async () => {
    await seedConfigPath(app, tempDir);
    app.ctx.config = {
      ...app.ctx.config,
      project: [{
        id: 'p1', repo: 'a/b', merge: null,
        agent: [[
          { id: 'becoming-manual', runtime: 'claude-code', role: 'dev', mode: 'local', yolo: true },
          { id: 'becoming-manual-qa', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/manual-qa', yolo: true },
        ]],
      }],
    };
    const sweepStaleBootstrapErrors = vi.fn().mockResolvedValue({ removed: 1 });
    app.ctx.errorRecordStore = { sweepStaleBootstrapErrors } as never;

    const response = await patch('/api/config', { project: [{
      id: 'p1', repo: 'a/b', merge: null,
      agent: [[
        { id: 'becoming-manual', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/manual', yolo: true },
        { id: 'becoming-manual-qa', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/manual-qa', yolo: true },
      ]],
    }] }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(200);
    const activeSet = sweepStaleBootstrapErrors.mock.calls[0][0] as Set<string>;
    expect(activeSet.has('becoming-manual')).toBe(false);
  });

  it('accepts language and persists it across PATCH and GET', async () => {
    await seedConfigPath(app, tempDir);
    const response = await patch('/api/config', { language: 'zh-CN' }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { config: BaxianConfig; restartRequired: boolean };
    expect(body.config.language).toBe('zh-CN');

    const followup = await patch('/api/config', { review: { rounds: 3 } }, { headers: JSON_HEADERS });
    const followupBody = JSON.parse(followup.body) as { config: BaxianConfig };
    expect(followupBody.config.language).toBe('zh-CN');

    const got = await get('/api/config');
    const gotBody = JSON.parse(got.body) as BaxianConfig;
    expect(gotBody.language).toBe('zh-CN');
  });

  it('does not flag restartRequired for a language change', async () => {
    await seedConfigPath(app, tempDir);
    const response = await patch('/api/config', { language: 'en-US' }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { restartRequired: boolean };
    expect(body.restartRequired).toBe(false);
  });

  it('rejects an invalid language with 400', async () => {
    await seedConfigPath(app, tempDir);
    const response = await patch('/api/config', { language: 'zh-cn' }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { details: Array<{ path: string; message: string }> };
    expect(body.details).toContainEqual({
      path: 'language',
      message: "language must be 'zh-CN' or 'en-US'",
    });
  });

  it('rejects an explicit null language with 400 instead of silently keeping the current value', async () => {
    await seedConfigPath(app, tempDir);
    const seeded = await patch('/api/config', { language: 'zh-CN' }, { headers: JSON_HEADERS });
    expect(seeded.statusCode).toBe(200);
    const response = await patch('/api/config', { language: null }, { headers: JSON_HEADERS });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { details: Array<{ path: string; message: string }> };
    expect(body.details).toContainEqual({
      path: 'language',
      message: "language must be 'zh-CN' or 'en-US'",
    });
    const got = await get('/api/config');
    const gotBody = JSON.parse(got.body) as BaxianConfig;
    expect(gotBody.language).toBe('zh-CN');
  });

  describe('restart-required diff', () => {
    async function patchAndRead(payload: unknown): Promise<{ statusCode: number; body: { restartRequired: boolean; note: string } }> {
      await seedConfigPath(app, tempDir);
      const response = await patch('/api/config', payload, { headers: JSON_HEADERS });
      return { statusCode: response.statusCode, body: JSON.parse(response.body) };
    }

    it('hot-reloads when only review/poller/token changes (restartRequired=false)', async () => {
      const agentReplace = vi.spyOn(app.ctx.agentManager, 'replaceConfig');
      const tmuxReplace = vi.fn();
      const bootstrapReplace = vi.fn();
      const reconcile = vi.fn();
      const reschedule = vi.fn();
      app.ctx.tmuxProbePoller = { replaceConfig: tmuxReplace, stop: vi.fn() } as never;
      app.ctx.bootstrapPoller = { replaceConfig: bootstrapReplace, stop: vi.fn() } as never;
      app.ctx.poller = { reconcile, reschedule, stop: vi.fn() } as never;
      app.ctx.platformEntryDeps = {
        driverFor: () => ({ visibilityLagMs: 0, commentSources: [] }),
        statePathFor: (repoUrl: string) => `/tmp/poller-${encodeURIComponent(repoUrl)}.json`,
      } as never;

      const { statusCode, body } = await patchAndRead({
        review: { rounds: 5 },
        server: { port: 3000, githubPollIntervalMs: 60000 },
      });
      expect(statusCode).toBe(200);
      expect(body.restartRequired).toBe(false);
      expect(agentReplace).toHaveBeenCalledTimes(1);
      expect(tmuxReplace).toHaveBeenCalledTimes(1);
      expect(bootstrapReplace).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reschedule).toHaveBeenCalledWith(60000);
    });

    it('requires a listener restart while still hot-applying the non-listener configuration', async () => {
      const agentReplace = vi.spyOn(app.ctx.agentManager, 'replaceConfig');
      const reconcile = vi.fn();
      const reschedule = vi.fn();
      app.ctx.poller = { reconcile, reschedule, stop: vi.fn() } as never;
      app.ctx.platformEntryDeps = {
        driverFor: () => ({ visibilityLagMs: 0, commentSources: [] }),
        statePathFor: (repoUrl: string) => `/tmp/poller-${encodeURIComponent(repoUrl)}.json`,
      } as never;

      const { statusCode, body } = await patchAndRead({
        review: { rounds: 7 },
        server: { port: 4444, githubPollIntervalMs: 45_000 },
      });
      expect(statusCode).toBe(200);
      expect(body.restartRequired).toBe(true);
      expect(body.note).toMatch(/restart/);
      expect(agentReplace).toHaveBeenCalledTimes(1);
      expect(app.ctx.agentManager.getConfig().review.rounds).toBe(7);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reschedule).toHaveBeenCalledWith(45_000);
    });

    it('fails before saving or swapping config when the retained-task scan fails', async () => {
      await seedConfigPath(app, tempDir);
      const before = await readFile(app.ctx.configPath!, 'utf8');
      const replace = vi.spyOn(app.ctx.agentManager, 'replaceConfig');
      vi.spyOn(app.ctx.agentManager, 'listActiveGitTasks')
        .mockRejectedValue(new Error('task schema invalid'));
      const reconcile = vi.fn();
      app.ctx.poller = { reconcile, reschedule: vi.fn(), stop: vi.fn() } as never;
      app.ctx.platformEntryDeps = {
        driverFor: () => ({ visibilityLagMs: 0, commentSources: [] }),
        statePathFor: (repoUrl: string) => `/tmp/poller-${encodeURIComponent(repoUrl)}.json`,
      } as never;

      const response = await patch('/api/config', { review: { rounds: 9 } }, { headers: JSON_HEADERS });

      expect(response.statusCode).toBe(500);
      expect(app.ctx.config.review.rounds).not.toBe(9);
      expect(await readFile(app.ctx.configPath!, 'utf8')).toBe(before);
      expect(replace).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    });

    it('requires restart when server.host changes', async () => {
      app.ctx.config = { ...app.ctx.config, server: { ...app.ctx.config.server, host: '0.0.0.0' } };
      const { statusCode, body } = await patchAndRead({ server: { port: 3000, host: '127.0.0.1' } });
      expect(statusCode).toBe(200);
      expect(body.restartRequired).toBe(true);
    });

    it('requires restart when server.https toggles or its key/cert paths change', async () => {
      const tmpA = join(tempDir, 'a.key');
      const tmpB = join(tempDir, 'b.key');
      const tmpCert = join(tempDir, 'a.cert');
      await Promise.all([
        writeFile(tmpA, 'k'), writeFile(tmpB, 'k2'), writeFile(tmpCert, 'c'),
      ]);
      app.ctx.config = {
        ...app.ctx.config,
        server: { ...app.ctx.config.server, https: { keyFile: tmpA, certFile: tmpCert } },
      };
      const { body } = await patchAndRead({
        server: { port: 3000, https: { keyFile: tmpB, certFile: tmpCert } },
      });
      expect(body.restartRequired).toBe(true);
    });

    it('requires restart when root agent configuration is added or removed', async () => {
      app.ctx.config = {
        ...app.ctx.config,
        project: app.ctx.config.project.map(project => ({
          ...project,
          agent: project.agent.map(pair => pair.map(agent => ({ ...agent, yolo: false }))),
        })),
      };
      const added = await patchAndRead({
        root: {
          runtime: 'codex',
          mode: 'local',
          workdir: join(tempDir, 'root-agent'),
          projects: ['proj'],
          responseTimeoutMinutes: 10,
        },
      });
      expect(added.statusCode).toBe(200);
      expect(added.body.restartRequired).toBe(true);
      expect(added.body.note).toContain('root');
      expect(app.ctx.config.root?.responseTimeoutMinutes).toBe(10);

      const removed = await patch('/api/config', { root: null }, { headers: JSON_HEADERS });
      expect(removed.statusCode).toBe(200);
      expect((JSON.parse(removed.body) as { restartRequired: boolean }).restartRequired).toBe(true);
      expect(app.ctx.config.root).toBeUndefined();
    });

    it('requires an explicit root stop before changing runtime placement', async () => {
      await seedConfigPath(app, tempDir);
      app.ctx.config = {
        ...app.ctx.config,
        project: app.ctx.config.project.map(project => ({
          ...project,
          agent: project.agent.map(pair => pair.map(agent => ({ ...agent, yolo: false }))),
        })),
        root: {
          runtime: 'codex',
          mode: 'local',
          workdir: join(tempDir, 'root-before'),
          yolo: true,
          responseTimeoutMinutes: 15,
        },
      };
      const isRuntimeLive = vi.fn(async () => false);
      app.ctx.rootRecoveryCoordinator = {
        isRuntimeExplicitlyStopped: vi.fn(() => false),
        isRuntimeLive,
        stop: vi.fn(async () => undefined),
      } as unknown as NonNullable<typeof app.ctx.rootRecoveryCoordinator>;

      const response = await patch('/api/config', {
        root: { ...app.ctx.config.root, workdir: join(tempDir, 'root-after') },
      }, { headers: JSON_HEADERS });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error).toMatch(/explicitly stopped/);
      expect(isRuntimeLive).not.toHaveBeenCalled();
      expect(app.ctx.config.root?.workdir).toBe(join(tempDir, 'root-before'));
    });

    it('allows a root runtime change only after stop and an absent-session recheck', async () => {
      await seedConfigPath(app, tempDir);
      app.ctx.config = {
        ...app.ctx.config,
        project: app.ctx.config.project.map(project => ({
          ...project,
          agent: project.agent.map(pair => pair.map(agent => ({ ...agent, yolo: false }))),
        })),
        root: {
          runtime: 'codex',
          mode: 'local',
          workdir: join(tempDir, 'root-before'),
          yolo: true,
          responseTimeoutMinutes: 15,
        },
      };
      const isRuntimeLive = vi.fn(async () => false);
      app.ctx.rootRecoveryCoordinator = {
        isRuntimeExplicitlyStopped: vi.fn(() => true),
        isRuntimeLive,
        stop: vi.fn(async () => undefined),
      } as unknown as NonNullable<typeof app.ctx.rootRecoveryCoordinator>;

      const nextWorkdir = join(tempDir, 'root-after');
      const response = await patch('/api/config', {
        root: { ...app.ctx.config.root, workdir: nextWorkdir },
      }, { headers: JSON_HEADERS });

      expect(response.statusCode).toBe(200);
      expect(isRuntimeLive).toHaveBeenCalledOnce();
      expect(app.ctx.config.root?.workdir).toBe(nextWorkdir);
    });

    it('rejects a root runtime change when the session reappears after stop', async () => {
      await seedConfigPath(app, tempDir);
      app.ctx.config = {
        ...app.ctx.config,
        root: {
          runtime: 'codex',
          mode: 'local',
          workdir: join(tempDir, 'root-before'),
          yolo: true,
          responseTimeoutMinutes: 15,
        },
      };
      app.ctx.rootRecoveryCoordinator = {
        isRuntimeExplicitlyStopped: vi.fn(() => true),
        isRuntimeLive: vi.fn(async () => true),
        stop: vi.fn(async () => undefined),
      } as unknown as NonNullable<typeof app.ctx.rootRecoveryCoordinator>;

      const response = await patch('/api/config', { root: null }, { headers: JSON_HEADERS });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error).toMatch(/became live/);
      expect(app.ctx.config.root).toBeDefined();
    });

    it('fails closed when the stopped root session cannot be rechecked', async () => {
      await seedConfigPath(app, tempDir);
      app.ctx.config = {
        ...app.ctx.config,
        root: {
          runtime: 'codex',
          mode: 'remote',
          host: { hostname: 'root.example.test' },
          workdir: '/srv/root-before',
          yolo: true,
          responseTimeoutMinutes: 15,
        },
      };
      app.ctx.rootRecoveryCoordinator = {
        isRuntimeExplicitlyStopped: vi.fn(() => true),
        isRuntimeLive: vi.fn(async () => { throw new Error('ssh timed out'); }),
        stop: vi.fn(async () => undefined),
      } as unknown as NonNullable<typeof app.ctx.rootRecoveryCoordinator>;

      const response = await patch('/api/config', { root: null }, { headers: JSON_HEADERS });

      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body).error).toMatch(/ssh timed out/);
      expect(app.ctx.config.root).toBeDefined();
    });

    it('does not require restart when allowedHosts changes', async () => {
      app.ctx.poller = { reschedule: vi.fn(), reconcile: vi.fn(), stop: vi.fn() } as never;
      const { body } = await patchAndRead({
        server: { port: 3000, allowedHosts: ['baxian.dev', 'admin.baxian.dev'] },
      });
      expect(body.restartRequired).toBe(false);
    });
  });
});

describe('GET /api/projects', () => {
  it('returns project list', async () => {
    const response = await get('/api/projects');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as ProjectConfig[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('proj');
    expect(body[0].repo).toBe('user/repo');
  });
});

describe('GET /api/projects/:id', () => {
  it('returns project details for known id', async () => {
    const response = await get('/api/projects/proj');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as ProjectConfig;
    expect(body.id).toBe('proj');
    expect(body.repo).toBe('user/repo');
  });

  it('returns 404 for unknown project', async () => {
    const response = await get('/api/projects/no-such-project');
    expect(response.statusCode).toBe(404);
  });
});
