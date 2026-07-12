import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapAutoRepos, runSingleTarget, collectTargets, classifyBootstrapError, autoBootstrapAgentIds } from '../../src/agent/bootstrap.js';
import { AgentStore, AGENT_STORE_NOOP } from '../../src/state/agent-store.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import { createRepoStoreCache, type RepoStore } from '../../src/agent/repo-store.js';
import type { BaxianConfig, BaxianEvent } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { CommandRunner } from '../../src/agent/runner.js';

const baseConfig: BaxianConfig = {
  review: { rounds: 10 },
  server: DEFAULT_SERVER_CONFIG,
  project: [{
    id: 'p1', repo: 'u/r1', merge: null,
    agent: [
      [
        { id: 'dev-a', runtime: 'claude-code', role: 'dev', mode: 'local' },
        { id: 'qa-a', runtime: 'codex', role: 'qa', mode: 'local' },
      ],
      [
        { id: 'dev-b', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/manual' },
      ],
    ],
  }],
};

let tempDir: string;
let agentStore: AgentStore;
let events: BaxianEvent[];
let eventBus: EventBus;
let mockRunner: CommandRunner;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-bootstrap-'));
  await initStateDir(tempDir);
  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  const eventLog = new EventLog(join(tempDir, 'events'));
  eventBus = new EventBus(eventLog);
  events = [];
  eventBus.on('*', (e: BaxianEvent) => { events.push(e); });
  mockRunner = {
    exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    writeFile: vi.fn(async () => undefined),
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true });
});

function repoStore(ensure: () => Promise<string>): RepoStore {
  return { ensure: vi.fn(ensure), refresh: vi.fn() } as unknown as RepoStore;
}

const hasEvent = (type: string): boolean => events.some(e => e.type === type);
const countEvents = (type: string): number => events.filter(e => e.type === type).length;

describe('bootstrapAutoRepos', () => {
  function autoBootstrapDeps(repoStoreFactory: () => RepoStore, config = baseConfig) {
    return {
      config,
      agentStore,
      eventBus,
      runnerFactory: () => mockRunner,
      repoCache: createRepoStoreCache(),
      repoStoreFactory,
    };
  }

  it('skips manual-mode agents', async () => {
    const ensure = vi.fn(async () => '/repo');
    await bootstrapAutoRepos(autoBootstrapDeps(
      () => ({ ensure, refresh: vi.fn() } as unknown as RepoStore),
    ));
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('on success: emits agent.bootstrap_succeeded but does NOT create state files for never-dispatched agents', async () => {
    await bootstrapAutoRepos(autoBootstrapDeps(() => repoStore(async () => '/r')));
    expect(hasEvent('agent.bootstrap_succeeded')).toBe(true);
    expect(await agentStore.get('dev-a')).toBeNull();
    expect(await agentStore.get('qa-a')).toBeNull();
  });

  it('on success: records the resolved Workdir on existing bindings', async () => {
    await agentStore.set({
      id: 'dev-a', projectId: 'p1', updatedAt: new Date().toISOString(),
    });
    await bootstrapAutoRepos(autoBootstrapDeps(() => repoStore(async () => '/r')));
    const state = await agentStore.get('dev-a');
    expect(state?.workdir).toBe('/r');
    expect(hasEvent('agent.bootstrap_succeeded')).toBe(true);
  });

  it('on failure: emits agent.bootstrap_failed without creating runtime state', async () => {
    await bootstrapAutoRepos(autoBootstrapDeps(
      () => repoStore(async () => { throw new Error('clone refused'); }),
    ));
    expect(hasEvent('agent.bootstrap_failed')).toBe(true);
    expect(await agentStore.get('dev-a')).toBeNull();
  });

  it('one per-agent clone failure does not block other agents', async () => {
    const config: BaxianConfig = {
      ...baseConfig,
      project: [
        ...baseConfig.project,
        { id: 'p2', repo: 'u/r2', merge: null, agent: [[
          { id: 'dev-c', runtime: 'claude-code', role: 'dev', mode: 'local' },
        ]] },
      ],
    };
    let calls = 0;
    await bootstrapAutoRepos(autoBootstrapDeps(
      () => repoStore(async () => {
        calls++;
        if (calls === 1) throw new Error('first fails');
        return '/r';
      }),
      config,
    ));
    expect(countEvents('agent.bootstrap_failed')).toBe(1);
    expect(countEvents('agent.bootstrap_succeeded')).toBe(2);
  });
});

describe('runSingleTarget — new behaviors', () => {
  const buildDeps = (overrides: {
    ensure?: () => Promise<string>;
    eventBus?: EventBus;
  } = {}) => ({
    config: baseConfig,
    agentStore,
    eventBus: overrides.eventBus ?? eventBus,
    runnerFactory: () => mockRunner,
    repoCache: createRepoStoreCache(),
    repoStoreFactory: () => repoStore(overrides.ensure ?? (async () => '/r')),
  });

  it('emitOnUnchanged=true + no bootstrapError to clear: emits succeeded', async () => {
    const target = collectTargets(baseConfig)[0];
    events.length = 0;
    await runSingleTarget(target, buildDeps(), { emitOnUnchanged: true });
    expect(hasEvent('agent.bootstrap_succeeded')).toBe(true);
  });

  it('purges stale bootstrap error records for the target agents on success', async () => {
    const purgeBootstrapForAgent = vi.fn().mockResolvedValue({ removed: 1 });
    const target = collectTargets(baseConfig)[0];
    await runSingleTarget(
      target,
      {
        ...buildDeps(),
        errorRecordStore: { purgeBootstrapForAgent } as never,
      },
      { emitOnUnchanged: true },
    );
    for (const agent of target.agents) {
      expect(purgeBootstrapForAgent).toHaveBeenCalledWith(agent.id);
    }
  });

  it('does NOT purge bootstrap errors on failure path (the new error must be visible)', async () => {
    const purgeBootstrapForAgent = vi.fn();
    const target = collectTargets(baseConfig)[0];
    await runSingleTarget(
      target,
      {
        ...buildDeps({ ensure: async () => { throw new Error('boom'); } }),
        errorRecordStore: {
          purgeBootstrapForAgent,
          append: vi.fn().mockResolvedValue(undefined),
        } as never,
      },
      { emitOnUnchanged: false },
    );
    expect(purgeBootstrapForAgent).not.toHaveBeenCalled();
  });

  it('calls onAgentAffected with target agent ids on manual retry (emitOnUnchanged=true)', async () => {
    const onAgentAffected = vi.fn();
    const target = collectTargets(baseConfig)[0];
    await runSingleTarget(target, { ...buildDeps(), onAgentAffected }, { emitOnUnchanged: true });
    expect(onAgentAffected).toHaveBeenCalledTimes(1);
    expect(onAgentAffected).toHaveBeenCalledWith(target.agents.map(a => a.id));
  });

  it.each<{ name: string; seedBindings: boolean; removed: number; called: boolean }>([
    { name: 'does NOT call onAgentAffected when only updated>0 (AgentStore.onChange already publishes)', seedBindings: true, removed: 0, called: false },
    { name: 'does NOT call onAgentAffected on steady-state success (no binding update, no stale error)', seedBindings: false, removed: 0, called: false },
    { name: 'DOES call onAgentAffected on success when a stale bootstrap error was actually cleared', seedBindings: false, removed: 1, called: true },
  ])('$name', async ({ seedBindings, removed, called }) => {
    if (seedBindings) {
      await agentStore.set({ id: 'dev-a', projectId: 'p1', updatedAt: '2026-05-23T00:00:00Z' });
      await agentStore.set({ id: 'qa-a', projectId: 'p1', updatedAt: '2026-05-23T00:00:00Z' });
    }
    const onAgentAffected = vi.fn();
    const purgeBootstrapForAgent = vi.fn().mockResolvedValue({ removed });
    const target = collectTargets(baseConfig)[0];
    await runSingleTarget(
      target,
      { ...buildDeps(), onAgentAffected, errorRecordStore: { purgeBootstrapForAgent } as never },
      { emitOnUnchanged: false },
    );
    if (called) expect(onAgentAffected).toHaveBeenCalledTimes(1);
    else expect(onAgentAffected).not.toHaveBeenCalled();
  });

  it('calls onAgentAffected on failure path (so the new red card pushes to open dashboards)', async () => {
    const onAgentAffected = vi.fn();
    const target = collectTargets(baseConfig)[0];
    await runSingleTarget(
      target,
      { ...buildDeps({ ensure: async () => { throw new Error('boom'); } }), onAgentAffected },
      { emitOnUnchanged: false },
    );
    expect(onAgentAffected).toHaveBeenCalledTimes(1);
    expect(onAgentAffected).toHaveBeenCalledWith(target.agents.map(a => a.id));
  });

  it('skips onAgentAffected when failure is suppressed (dedup path)', async () => {
    const onAgentAffected = vi.fn();
    const target = collectTargets(baseConfig)[0];
    await runSingleTarget(
      target,
      { ...buildDeps({ ensure: async () => { throw new Error('same'); } }), onAgentAffected },
      { emitOnUnchanged: false, suppressFailureMessage: 'same' },
    );
    expect(onAgentAffected).not.toHaveBeenCalled();
  });

  it('emitOnUnchanged=false + no bootstrapError to clear: does NOT emit', async () => {
    const target = collectTargets(baseConfig)[0];
    events.length = 0;
    await runSingleTarget(target, buildDeps(), { emitOnUnchanged: false });
    expect(hasEvent('agent.bootstrap_succeeded')).toBe(false);
  });

  it('emitOnUnchanged=false + existing binding updated: emits succeeded with updated count', async () => {
    const now = new Date().toISOString();
    await agentStore.set({ id: 'dev-a', projectId: 'p1', updatedAt: now });
    const target = collectTargets(baseConfig)[0];
    events.length = 0;
    await runSingleTarget(target, buildDeps(), { emitOnUnchanged: false });
    expect((await agentStore.get('dev-a'))?.workdir).toBe('/r');
    const success = events.find(e => e.type === 'agent.bootstrap_succeeded');
    expect(success).toBeTruthy();
    expect((success!.data as { updated: number }).updated).toBe(1);
  });

  it('emitOnUnchanged=false + binding write fails: does not count the failed write as updated', async () => {
    const now = new Date().toISOString();
    await agentStore.set({ id: 'dev-a', projectId: 'p1', updatedAt: now });
    const originalUpdate = agentStore.update.bind(agentStore);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(agentStore, 'update').mockImplementation(async (id, updater) => {
      if (id !== 'dev-a') return originalUpdate(id, updater);
      const existing = await agentStore.get(id);
      const result = updater(existing);
      if (result === AGENT_STORE_NOOP) return undefined;
      throw new Error('write failed');
    });

    const target = collectTargets(baseConfig)[0];
    events.length = 0;
    await runSingleTarget(target, buildDeps(), { emitOnUnchanged: false });

    expect((await agentStore.get('dev-a'))?.workdir).toBeUndefined();
    expect(hasEvent('agent.bootstrap_succeeded')).toBe(false);
  });

  it('emit reject after successful ensure is swallowed (does not poison ensure path)', async () => {
    const now = new Date().toISOString();
    await agentStore.set({ id: 'dev-a', projectId: 'p1', updatedAt: now });
    const failingBus = {
      emit: vi.fn().mockRejectedValue(new Error('emit boom')),
      on: () => {},
      off: () => {},
    } as unknown as EventBus;
    const target = collectTargets(baseConfig)[0];
    await expect(
      runSingleTarget(target, buildDeps({ eventBus: failingBus }), { emitOnUnchanged: false }),
    ).resolves.toEqual({ ok: true });
    expect((await agentStore.get('dev-a'))?.workdir).toBe('/r');
  });

  it('failure emits bootstrap_failed even when bindings already exist', async () => {
    const now = new Date().toISOString();
    await agentStore.set({ id: 'dev-a', projectId: 'p1', updatedAt: now });
    await agentStore.set({ id: 'qa-a', projectId: 'p1', updatedAt: now });
    const target = collectTargets(baseConfig)[0];
    events.length = 0;
    await runSingleTarget(target, buildDeps({ ensure: async () => { throw new Error('same err'); } }), { emitOnUnchanged: false });
    expect(countEvents('agent.bootstrap_failed')).toBe(1);
  });
});

describe('classifyBootstrapError', () => {
  const repo = 'owner/missing';
  const ACCESS = 'BOOTSTRAP_REPO_ACCESS_DENIED';
  const ENSURE = 'BOOTSTRAP_REPO_ENSURE_FAILED';
  type Out = ReturnType<typeof classifyBootstrapError>;

  it.each<{ name: string; input: string; reason: string; extra?: (out: Out) => void }>([
    {
      name: 'maps gh GraphQL "Could not resolve to a Repository" to ACCESS_DENIED',
      input: `gh repo clone ${repo} failed: GraphQL: Could not resolve to a Repository with the name 'owner/missing'. (repository)`,
      reason: ACCESS,
      extra: out => {
        expect(out.message).toContain('"owner/missing"');
        expect(out.message).toContain('Could not resolve to a Repository');
        expect(out.recommendation).toContain('collaborator');
      },
    },
    { name: 'maps "Repository not found" (gh CLI) to ACCESS_DENIED', input: 'fatal: Repository not found', reason: ACCESS },
    { name: 'maps bare "404" (gh poller failure) to ACCESS_DENIED', input: 'gh: Not Found (HTTP 404)', reason: ACCESS },
    { name: 'maps "Permission denied (publickey)" (ssh git clone) to ACCESS_DENIED', input: 'Permission denied (publickey).', reason: ACCESS },
    {
      name: 'falls through to ENSURE_FAILED for network / unknown failures',
      input: 'connect ETIMEDOUT 140.82.121.4:443',
      reason: ENSURE,
      extra: out => { expect(out.message).toBe('connect ETIMEDOUT 140.82.121.4:443'); },
    },
    { name: 'does NOT match "404" embedded in longer numbers (word-boundary guard)', input: 'exit code 4040', reason: ENSURE },
    {
      name: 'does NOT classify local mkdir EACCES as ACCESS_DENIED — would mislead UI to "grant gh collaborator"',
      input: `EACCES: permission denied, mkdir '/var/baxian/repos/${repo}'`,
      reason: ENSURE,
      extra: out => { expect(out.recommendation).not.toContain('collaborator'); },
    },
    { name: 'does NOT classify standalone "access denied" without GitHub context as ACCESS_DENIED', input: 'access denied: filesystem readonly', reason: ENSURE },
    { name: 'treats bare "Permission denied" PAIRED with github.com mention as ACCESS_DENIED', input: 'Permission denied while talking to https://github.com/...', reason: ACCESS },
    { name: 'does NOT classify "sh: gh: command not found" as ACCESS_DENIED', input: 'sh: gh: command not found', reason: ENSURE },
    { name: 'does NOT classify "gh: API rate limit exceeded" as ACCESS_DENIED (no auth keyword)', input: 'gh: API rate limit exceeded', reason: ENSURE },
    { name: 'DOES classify line-start "gh: Not Found (HTTP 404)" as ACCESS_DENIED', input: 'gh: Not Found (HTTP 404)', reason: ACCESS },
  ])('$name', ({ input, reason, extra }) => {
    const out = classifyBootstrapError(input, repo);
    expect(out.reason).toBe(reason);
    extra?.(out);
  });
});

describe('classifyBootstrapError — non-GitHub (generic git) repos', () => {
  const repo = 'https://gitlab.example.com/group/proj.git';
  const ACCESS = 'BOOTSTRAP_REPO_ACCESS_DENIED';
  const ENSURE = 'BOOTSTRAP_REPO_ENSURE_FAILED';
  const credRepo = 'https://oauth2:SECRETTOKEN@gitlab.example.com/group/proj.git';
  type Out = ReturnType<typeof classifyBootstrapError>;

  it.each<{ name: string; input: string; repo?: string; reason: string; extra?: (out: Out) => void }>([
    {
      name: 'maps https auth failure (URL-scheme context) to ACCESS_DENIED with a neutral, host-scoped hint',
      input: `git clone ${repo} failed: fatal: Authentication failed for 'https://gitlab.example.com/group/proj.git/'`,
      reason: ACCESS,
      extra: out => {
        expect(out.recommendation).toContain('gitlab.example.com');
        expect(out.recommendation).not.toContain('collaborator');
      },
    },
    { name: 'maps ssh "Permission denied (publickey)" to ACCESS_DENIED', input: 'git@gitlab.example.com: Permission denied (publickey).', reason: ACCESS },
    { name: 'maps repository-not-found (with scheme) to ACCESS_DENIED', input: `fatal: repository 'https://gitlab.example.com/group/proj.git/' not found`, reason: ACCESS },
    { name: 'host-unreachable (no scheme / auth keyword) stays ENSURE_FAILED', input: 'fatal: unable to access: Could not resolve host: gitlab.example.com', reason: ENSURE },
    { name: 'does NOT match a local mkdir error that merely embeds the repos-ext host path', input: "EACCES: permission denied, mkdir '/home/u/.baxian/repos-ext/gitlab.example.com/group/proj'", reason: ENSURE },
    { name: 'does NOT classify "git: command not found" (with URL context) as ACCESS_DENIED', input: `git clone ${repo} failed: /bin/sh: git: command not found`, reason: ENSURE },
    { name: 'does NOT classify dash\'s "git: not found" (missing binary) as ACCESS_DENIED', input: `git clone ${repo} failed: /bin/sh: 1: git: not found`, reason: ENSURE },
    {
      name: 'redacts an embedded token from the access-denied classification message',
      input: `git clone ${credRepo} failed: fatal: Authentication failed for '${credRepo}/'`,
      repo: credRepo,
      reason: ACCESS,
      extra: out => {
        expect(out.message).not.toContain('SECRETTOKEN');
        expect(out.message).toContain('gitlab.example.com');
      },
    },
  ])('$name', ({ input, repo: rowRepo, reason, extra }) => {
    const out = classifyBootstrapError(input, rowRepo ?? repo);
    expect(out.reason).toBe(reason);
    extra?.(out);
  });
});

describe('autoBootstrapAgentIds', () => {
  it('includes auto-mode agents (no workdir) and excludes explicit-workdir agents', () => {
    const config: BaxianConfig = {
      github: {} as never, review: { rounds: 10 }, server: DEFAULT_SERVER_CONFIG,
      project: [{
        id: 'p', repo: 'u/r', merge: null,
        agent: [
          [
            { id: 'auto-dev', runtime: 'claude-code', role: 'dev', mode: 'local' },
            { id: 'manual-qa', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/wd' },
          ],
        ],
      }],
    };
    const ids = autoBootstrapAgentIds(config);
    expect(ids.has('auto-dev')).toBe(true);
    expect(ids.has('manual-qa')).toBe(false);
    expect(ids.size).toBe(1);
  });
});

describe('collectTargets host resolution (string id refs)', () => {
  it('groups a remote agent by its resolved endpoint, not remote:@', () => {
    const config: BaxianConfig = {
      review: { rounds: 10 },
      server: DEFAULT_SERVER_CONFIG,
      host: [{ id: 'box', hostname: 'box.example.com', port: 2222, user: 'agent' }],
      project: [{
        id: 'p1', repo: 'u/r', merge: null,
        agent: [[{ id: 'rdev', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' }]],
      }],
    };
    const targets = collectTargets(config);
    expect(targets).toHaveLength(1);
    expect(targets[0].resolvedHost).toEqual({ id: 'box', hostname: 'box.example.com', port: 2222, user: 'agent' });
  });

  it('keeps agents on the same machine as separate clone targets', () => {
    const config: BaxianConfig = {
      review: { rounds: 10 },
      server: DEFAULT_SERVER_CONFIG,
      host: [
        { id: 'box', hostname: 'h', port: 22, user: 'u' },
        { id: 'box2', hostname: 'h', port: 22, user: 'u' },
      ],
      project: [{
        id: 'p1', repo: 'u/r', merge: null,
        agent: [
          [{ id: 'da', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' }],
          [{ id: 'db', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box2' }],
        ],
      }],
    };
    const targets = collectTargets(config);
    expect(targets).toHaveLength(2);
    expect(targets.map(target => target.representativeAgent.id)).toEqual(['da', 'db']);
  });
});
