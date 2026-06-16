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

describe('bootstrapAutoRepos', () => {
  it('skips manual-mode agents', async () => {
    const ensure = vi.fn(async () => '/repo');
    await bootstrapAutoRepos({
      config: baseConfig,
      agentStore,
      eventBus,
      runnerFactory: () => mockRunner,
      repoCache: createRepoStoreCache(),
      repoStoreFactory: () => ({ ensure, refresh: vi.fn() } as unknown as RepoStore),
    });
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('on success: emits agent.bootstrap_succeeded but does NOT create state files for never-dispatched agents', async () => {
    await bootstrapAutoRepos({
      config: baseConfig,
      agentStore,
      eventBus,
      runnerFactory: () => mockRunner,
      repoCache: createRepoStoreCache(),
      repoStoreFactory: () => ({ ensure: vi.fn(async () => '/r'), refresh: vi.fn() } as unknown as RepoStore),
    });
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(true);
    expect(await agentStore.get('dev-a')).toBeNull();
    expect(await agentStore.get('qa-a')).toBeNull();
  });

  it('on success: records repoPath on existing bindings', async () => {
    await agentStore.set({
      id: 'dev-a', projectId: 'p1', updatedAt: new Date().toISOString(),
    });
    await bootstrapAutoRepos({
      config: baseConfig,
      agentStore,
      eventBus,
      runnerFactory: () => mockRunner,
      repoCache: createRepoStoreCache(),
      repoStoreFactory: () => ({ ensure: vi.fn(async () => '/r'), refresh: vi.fn() } as unknown as RepoStore),
    });
    const state = await agentStore.get('dev-a');
    expect(state?.repoPath).toBe('/r');
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(true);
  });

  it('on failure: emits agent.bootstrap_failed without creating runtime state', async () => {
    await bootstrapAutoRepos({
      config: baseConfig,
      agentStore,
      eventBus,
      runnerFactory: () => mockRunner,
      repoCache: createRepoStoreCache(),
      repoStoreFactory: () => ({
        ensure: vi.fn(async () => { throw new Error('clone refused'); }),
        refresh: vi.fn(),
      } as unknown as RepoStore),
    });
    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(true);
    expect(await agentStore.get('dev-a')).toBeNull();
  });

  it('one (project, host) failure does not block others', async () => {
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
    await bootstrapAutoRepos({
      config,
      agentStore,
      eventBus,
      runnerFactory: () => mockRunner,
      repoCache: createRepoStoreCache(),
      repoStoreFactory: () => ({
        ensure: vi.fn(async () => {
          calls++;
          if (calls === 1) throw new Error('first fails');
          return '/r';
        }),
        refresh: vi.fn(),
      } as unknown as RepoStore),
    });
    expect(events.filter(e => e.type === 'agent.bootstrap_failed')).toHaveLength(1);
    expect(events.filter(e => e.type === 'agent.bootstrap_succeeded')).toHaveLength(1);
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
    repoStoreFactory: () => ({
      ensure: vi.fn(overrides.ensure ?? (async () => '/r')),
      refresh: vi.fn(),
    } as unknown as RepoStore),
  });

  it('emitOnUnchanged=true + no bootstrapError to clear: emits succeeded', async () => {
    const target = collectTargets(baseConfig)[0];
    events.length = 0;
    await runSingleTarget(target, buildDeps(), { emitOnUnchanged: true });
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(true);
  });

  it('purges stale bootstrap error records for the target agents on success', async () => {
    // Truth source for the red card is errorRecordStore presence (snapshot.ts no longer
    // gates on binding.repoPath). Success must clear those records or the card sticks
    // forever for never-dispatched agents (no binding for repoPath to land on) and shows a
    // misleading stale failure for first-success-then-regress cycles.
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
    // Manual retry path always notifies — operator clicked Retry expecting fresh signal.
    const onAgentAffected = vi.fn();
    const target = collectTargets(baseConfig)[0];
    await runSingleTarget(target, { ...buildDeps(), onAgentAffected }, { emitOnUnchanged: true });
    expect(onAgentAffected).toHaveBeenCalledTimes(1);
    expect(onAgentAffected).toHaveBeenCalledWith(target.agents.map(a => a.id));
  });

  it('does NOT call onAgentAffected when only updated>0 (AgentStore.onChange already publishes)', async () => {
    // Pre-seed a binding so agentStore.update goes through wasUpdated=true → updated > 0.
    // In production AgentStore.onChange is wired to eventPublisher.publishAgentChange already;
    // calling onAgentAffected here too would double-publish the same snapshot.
    await agentStore.set({ id: 'dev-a', projectId: 'p1', updatedAt: '2026-05-23T00:00:00Z' });
    await agentStore.set({ id: 'qa-a', projectId: 'p1', updatedAt: '2026-05-23T00:00:00Z' });
    const onAgentAffected = vi.fn();
    const purgeBootstrapForAgent = vi.fn().mockResolvedValue({ removed: 0 });
    const target = collectTargets(baseConfig)[0];
    await runSingleTarget(
      target,
      {
        ...buildDeps(),
        onAgentAffected,
        errorRecordStore: { purgeBootstrapForAgent } as never,
      },
      { emitOnUnchanged: false },
    );
    expect(onAgentAffected).not.toHaveBeenCalled();
  });

  it('does NOT call onAgentAffected on steady-state success (no binding update, no stale error)', async () => {
    // Periodic BootstrapPoller path: emitOnUnchanged=false, no existing binding to update,
    // no stale error to purge → snapshot unchanged → no synthetic publish (otherwise we'd
    // push agents-topic updates every 60s for every stable agent under load).
    const onAgentAffected = vi.fn();
    const purgeBootstrapForAgent = vi.fn().mockResolvedValue({ removed: 0 });
    const target = collectTargets(baseConfig)[0];
    await runSingleTarget(
      target,
      {
        ...buildDeps(),
        onAgentAffected,
        errorRecordStore: { purgeBootstrapForAgent } as never,
      },
      { emitOnUnchanged: false },
    );
    expect(onAgentAffected).not.toHaveBeenCalled();
  });

  it('DOES call onAgentAffected on success when a stale bootstrap error was actually cleared', async () => {
    // The "Retry resolved the issue" workflow: bootstrap error existed → success path purges
    // it → snapshot changes (red card disappears) → must notify subscribers even if updated=0.
    const onAgentAffected = vi.fn();
    const purgeBootstrapForAgent = vi.fn().mockResolvedValue({ removed: 1 });
    const target = collectTargets(baseConfig)[0];
    await runSingleTarget(
      target,
      {
        ...buildDeps(),
        onAgentAffected,
        errorRecordStore: { purgeBootstrapForAgent } as never,
      },
      { emitOnUnchanged: false },
    );
    expect(onAgentAffected).toHaveBeenCalledTimes(1);
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
    // If the message matches suppressFailureMessage, we don't append/emit — and we also shouldn't
    // republish a phantom "snapshot changed" event since the snapshot is in fact unchanged.
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
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
  });

  it('emitOnUnchanged=false + existing binding updated: emits succeeded with updated count', async () => {
    const now = new Date().toISOString();
    await agentStore.set({ id: 'dev-a', projectId: 'p1', updatedAt: now });
    const target = collectTargets(baseConfig)[0];
    events.length = 0;
    await runSingleTarget(target, buildDeps(), { emitOnUnchanged: false });
    expect((await agentStore.get('dev-a'))?.repoPath).toBe('/r');
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

    expect((await agentStore.get('dev-a'))?.repoPath).toBeUndefined();
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
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
    expect((await agentStore.get('dev-a'))?.repoPath).toBe('/r');
  });

  it('failure emits bootstrap_failed even when bindings already exist', async () => {
    const now = new Date().toISOString();
    await agentStore.set({ id: 'dev-a', projectId: 'p1', updatedAt: now });
    await agentStore.set({ id: 'qa-a', projectId: 'p1', updatedAt: now });
    const target = collectTargets(baseConfig)[0];
    events.length = 0;
    await runSingleTarget(target, buildDeps({ ensure: async () => { throw new Error('same err'); } }), { emitOnUnchanged: false });
    expect(events.filter(e => e.type === 'agent.bootstrap_failed')).toHaveLength(1);
  });
});

describe('classifyBootstrapError', () => {
  const repo = 'owner/missing';

  // Real GraphQL phrasing from `gh repo clone` against a private repo the active gh account
  // isn't a collaborator on. This must classify as ACCESS_DENIED so the UI surfaces an
  // actionable "grant collaborator" hint instead of a generic ensure-failed message.
  it('maps gh GraphQL "Could not resolve to a Repository" to ACCESS_DENIED', () => {
    const out = classifyBootstrapError(
      `gh repo clone ${repo} failed: GraphQL: Could not resolve to a Repository with the name 'owner/missing'. (repository)`,
      repo,
    );
    expect(out.reason).toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
    expect(out.message).toContain('"owner/missing"');
    expect(out.message).toContain('Could not resolve to a Repository');
    expect(out.recommendation).toContain('collaborator');
  });

  it('maps "Repository not found" (gh CLI) to ACCESS_DENIED', () => {
    expect(classifyBootstrapError('fatal: Repository not found', repo).reason)
      .toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
  });

  it('maps bare "404" (gh poller failure) to ACCESS_DENIED', () => {
    expect(classifyBootstrapError('gh: Not Found (HTTP 404)', repo).reason)
      .toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
  });

  it('maps "Permission denied (publickey)" (ssh git clone) to ACCESS_DENIED', () => {
    // SSH-specific marker is GitHub context enough.
    expect(classifyBootstrapError('Permission denied (publickey).', repo).reason)
      .toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
  });

  it('falls through to ENSURE_FAILED for network / unknown failures', () => {
    const out = classifyBootstrapError('connect ETIMEDOUT 140.82.121.4:443', repo);
    expect(out.reason).toBe('BOOTSTRAP_REPO_ENSURE_FAILED');
    expect(out.message).toBe('connect ETIMEDOUT 140.82.121.4:443');
  });

  it('does NOT match "404" embedded in longer numbers (word-boundary guard)', () => {
    expect(classifyBootstrapError('exit code 4040', repo).reason)
      .toBe('BOOTSTRAP_REPO_ENSURE_FAILED');
  });

  it('does NOT classify local mkdir EACCES as ACCESS_DENIED — would mislead UI to "grant gh collaborator"', () => {
    // Local fs permission errors share the keyword "Permission denied" but have no GitHub
    // context. The repo recommendation would point the user at the wrong fix.
    const out = classifyBootstrapError(
      `EACCES: permission denied, mkdir '/var/baxian/repos/${repo}'`,
      repo,
    );
    expect(out.reason).toBe('BOOTSTRAP_REPO_ENSURE_FAILED');
    expect(out.recommendation).not.toContain('collaborator');
  });

  it('does NOT classify standalone "access denied" without GitHub context as ACCESS_DENIED', () => {
    expect(classifyBootstrapError('access denied: filesystem readonly', repo).reason)
      .toBe('BOOTSTRAP_REPO_ENSURE_FAILED');
  });

  it('treats bare "Permission denied" PAIRED with github.com mention as ACCESS_DENIED', () => {
    expect(classifyBootstrapError('Permission denied while talking to https://github.com/...', repo).reason)
      .toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
  });

  it('does NOT classify "sh: gh: command not found" as ACCESS_DENIED', () => {
    // Round-3 review: bare /\\bgh:\\s/i was too broad and caught gh CLI runtime errors
    // (tool missing, rate limited, etc.) which need a different fix (install/auth gh), not
    // "grant collaborator access". /^gh:\\s/m (line-start) lets `gh: Not Found (HTTP 404)`
    // upgrade via the 404 generic but stops the `sh: gh:` shell-prefix form.
    expect(classifyBootstrapError('sh: gh: command not found', repo).reason)
      .toBe('BOOTSTRAP_REPO_ENSURE_FAILED');
  });

  it('does NOT classify "gh: API rate limit exceeded" as ACCESS_DENIED (no auth keyword)', () => {
    // Even with line-start `gh:`, no generic-auth keyword means no upgrade.
    expect(classifyBootstrapError('gh: API rate limit exceeded', repo).reason)
      .toBe('BOOTSTRAP_REPO_ENSURE_FAILED');
  });

  it('DOES classify line-start "gh: Not Found (HTTP 404)" as ACCESS_DENIED', () => {
    // Line-start `gh:` is real github context; combined with `HTTP 404` generic → upgrade.
    expect(classifyBootstrapError('gh: Not Found (HTTP 404)', repo).reason)
      .toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
  });
});

describe('classifyBootstrapError — non-GitHub (generic git) repos', () => {
  const repo = 'https://gitlab.example.com/group/proj.git';

  it('maps https auth failure (URL-scheme context) to ACCESS_DENIED with a neutral, host-scoped hint', () => {
    const out = classifyBootstrapError(
      `git clone ${repo} failed: fatal: Authentication failed for 'https://gitlab.example.com/group/proj.git/'`,
      repo,
    );
    expect(out.reason).toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
    expect(out.recommendation).toContain('gitlab.example.com');
    expect(out.recommendation).not.toContain('collaborator');
  });

  it('maps ssh "Permission denied (publickey)" to ACCESS_DENIED', () => {
    expect(classifyBootstrapError('git@gitlab.example.com: Permission denied (publickey).', repo).reason)
      .toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
  });

  it('maps repository-not-found (with scheme) to ACCESS_DENIED', () => {
    expect(classifyBootstrapError(
      `fatal: repository 'https://gitlab.example.com/group/proj.git/' not found`, repo,
    ).reason).toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
  });

  it('host-unreachable (no scheme / auth keyword) stays ENSURE_FAILED', () => {
    expect(classifyBootstrapError(
      'fatal: unable to access: Could not resolve host: gitlab.example.com', repo,
    ).reason).toBe('BOOTSTRAP_REPO_ENSURE_FAILED');
  });

  it('does NOT match a local mkdir error that merely embeds the repos-ext host path', () => {
    // The repos-ext dir embeds the host, but a local fs error carries no scheme / git@ / publickey.
    expect(classifyBootstrapError(
      "EACCES: permission denied, mkdir '/home/u/.baxian/repos-ext/gitlab.example.com/group/proj'", repo,
    ).reason).toBe('BOOTSTRAP_REPO_ENSURE_FAILED');
  });

  it('does NOT classify "git: command not found" (with URL context) as ACCESS_DENIED', () => {
    // git binary missing on the agent host — a shell command-not-found, not a remote repo-not-found.
    expect(classifyBootstrapError(`git clone ${repo} failed: /bin/sh: git: command not found`, repo).reason)
      .toBe('BOOTSTRAP_REPO_ENSURE_FAILED');
  });

  it('does NOT classify dash\'s "git: not found" (missing binary) as ACCESS_DENIED', () => {
    // dash (/bin/sh on Debian) prints "git: not found" without "command" — still a missing binary.
    expect(classifyBootstrapError(`git clone ${repo} failed: /bin/sh: 1: git: not found`, repo).reason)
      .toBe('BOOTSTRAP_REPO_ENSURE_FAILED');
  });

  it('redacts an embedded token from the access-denied classification message', () => {
    const credRepo = 'https://oauth2:SECRETTOKEN@gitlab.example.com/group/proj.git';
    const out = classifyBootstrapError(
      `git clone ${credRepo} failed: fatal: Authentication failed for '${credRepo}/'`, credRepo,
    );
    expect(out.reason).toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
    expect(out.message).not.toContain('SECRETTOKEN');
    expect(out.message).toContain('gitlab.example.com');
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

describe('collectTargets host resolution (string id refs, f-2)', () => {
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

  it('collapses two agents referencing the same machine (different ids, same endpoint) into one bootstrap group', () => {
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
    expect(collectTargets(config)).toHaveLength(1);
  });
});
