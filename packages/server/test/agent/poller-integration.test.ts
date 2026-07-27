import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentConfig, BaxianConfig, BaxianEvent } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { AgentManager } from '../../src/agent/manager.js';
import { TmuxProbePoller, TmuxSessionStatusStore } from '../../src/agent/tmux-probe-poller.js';
import { BootstrapPoller } from '../../src/agent/bootstrap-poller.js';
import { createRepoStoreCache } from '../../src/agent/repo-store.js';
import { initStateDir } from '../../src/state/init.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import type { CommandRunner } from '../../src/agent/runner.js';

const NOW = '2026-04-28T10:00:00Z';
const devAgent: AgentConfig = {
  id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local',
};
const qaAgent: AgentConfig = {
  id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local',
};
const config: BaxianConfig = {
  review: { rounds: 10 },
  server: DEFAULT_SERVER_CONFIG,
  project: [{ id: 'proj', repo: 'user/repo', merge: null, agent: [[devAgent, qaAgent]] }],
};
const noopRunner: CommandRunner = {
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  writeFile: async () => {},
};

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let agentManager: AgentManager;
const events: BaxianEvent[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-integration-'));
  await initStateDir(tempDir);
  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  events.length = 0;
  eventBus.on('*', (e) => { events.push(e); });
  const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
  agentManager = new AgentManager({
    config, agentStore, taskStore, lockManager, eventBus,
    skillRegistry,
    runnerFactory: () => noopRunner,
  });
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
      runnerFactory: () => ({
        exec: async (cmd: string) => cmd.includes('tmux has-session')
          ? { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 },
        writeFile: async () => {},
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
      runnerFactory: () => ({
        exec: async (cmd: string) => cmd.includes('tmux has-session')
          ? { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 },
        writeFile: async () => {},
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
