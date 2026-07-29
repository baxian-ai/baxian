import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig, BaxianEvent } from '../../src/shared/index.js';
import type { AgentStore } from '../../src/state/agent-store.js';
import type { LockManager } from '../../src/state/lock.js';
import type { EventBus } from '../../src/event/bus.js';
import type { AgentManager } from '../../src/agent/manager.js';
import { TmuxProbePoller, TmuxSessionStatusStore } from '../../src/agent/tmux-probe-poller.js';
import { BootstrapPoller } from '../../src/agent/bootstrap-poller.js';
import { createRepoStoreCache } from '../../src/agent/repo-store.js';
import type { CommandRunner } from '../../src/agent/runner.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { fakeRunner } from '../helpers/fake-runner.js';
import { makeAgent, makeConfig } from '../helpers/fixtures.js';

const NOW = '2026-04-28T10:00:00Z';

let tempDir: string;
let config: BaxianConfig;
let agentStore: AgentStore;
let lockManager: LockManager;
let eventBus: EventBus;
let agentManager: AgentManager;
let noopRunner: CommandRunner;
let events: BaxianEvent[];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-integration-'));
  noopRunner = fakeRunner({ defaultResult: {} });
  const pollerConfig = makeConfig({
    project: [{
      id: 'proj',
      repo: 'user/repo',
      merge: null,
      agent: [[
        makeAgent({ workdir: undefined }),
        makeAgent({ id: 'qa-1', runtime: 'codex', role: 'qa', workdir: undefined }),
      ]],
    }],
  });
  const harness = await createManagerHarness(tempDir, {
    config: pollerConfig,
    deps: {
      runnerFactory: () => noopRunner,
      platformRunner: noopRunner,
    },
  });
  ({
    config,
    manager: agentManager,
    agentStore,
    lockManager,
    eventBus,
    events,
  } = harness);
});

afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

describe('poller integration', () => {
  it('absent tmux probe holds the binding and exclusive lock within one tick', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj',
      taskId: 'orphan',
      paneId: 'pane-7',
      workdir: '/tmp/repo',
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1', 'orphan');

    const probePoller = new TmuxProbePoller({
      config, store: new TmuxSessionStatusStore(), agentManager,
      runnerFactory: () => fakeRunner({
        rules: [{
          match: 'tmux has-session',
          reply: { stderr: "can't find session: dev-1", exitCode: 1 },
        }],
        defaultResult: {},
      }),
      intervalMs: 10_000,
    });
    await probePoller.pollOnce();

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBe('orphan');
    expect(state?.paneId).toBeUndefined();
    expect(state?.workdir).toBe('/tmp/repo');
    expect(state).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'runtime-missing' });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    const recovered = events.find(e => e.type === 'agent.recovered' && e.agentId === 'dev-1');
    expect(recovered?.data).toEqual({ reason: 'tmux-probe=absent' });
  });

  it('absent tmux probe does not steal ownership from in-flight bootstrap', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      creationToken: 'create-1',
      updatedAt: NOW,
    });

    const probePoller = new TmuxProbePoller({
      config, store: new TmuxSessionStatusStore(), agentManager,
      runnerFactory: () => fakeRunner({
        rules: [{
          match: 'tmux has-session',
          reply: { stderr: "can't find session: dev-1", exitCode: 1 },
        }],
        defaultResult: {},
      }),
      intervalMs: 10_000,
    });
    await probePoller.pollOnce();

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe('create-1');
    expect(events.some(e => e.type === 'agent.recovered' && e.agentId === 'dev-1')).toBe(false);
  });

  it('BootstrapPoller records Workdir on existing binding', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', updatedAt: NOW,
    });
    const poller = new BootstrapPoller({
      config, agentStore, eventBus,
      repoCache: createRepoStoreCache(),
      runnerFactory: () => noopRunner,
      repoStoreFactory: (() => ({ ensure: async () => '/path/to/repo' })) as never,
      intervalMs: 60_000,
    });
    await poller.pollOnce();
    const state = await agentStore.get('dev-1');
    expect(state?.workdir).toBe('/path/to/repo');
    const succeeded = events.filter(e => e.type === 'agent.bootstrap_succeeded');
    expect(succeeded).toHaveLength(1);
    expect((succeeded[0] as { data: { updated: number } }).data.updated).toBe(1);
  });

  it('healthy repo: BootstrapPoller 5 cycles produces zero events', async () => {
    const poller = new BootstrapPoller({
      config, agentStore, eventBus,
      repoCache: createRepoStoreCache(),
      runnerFactory: () => noopRunner,
      repoStoreFactory: (() => ({ ensure: async () => '/p' })) as never,
      intervalMs: 60_000,
    });
    for (let i = 0; i < 5; i++) await poller.pollOnce();
    expect(events.filter(e => e.type === 'agent.bootstrap_succeeded')).toHaveLength(0);
  });
});
