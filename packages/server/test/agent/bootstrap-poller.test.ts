import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentConfig, BaxianConfig, BaxianEvent } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { BootstrapPoller } from '../../src/agent/bootstrap-poller.js';
import { createRepoStoreCache } from '../../src/agent/repo-store.js';
import { initStateDir } from '../../src/state/init.js';
import { ErrorRecordStore } from '../../src/state/error-record-store.js';

const NOW = '2026-04-28T10:00:00Z';
const devAgent: AgentConfig = {
  id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local',
};
const config: BaxianConfig = {
  github: {} as never, review: { rounds: 10 }, server: DEFAULT_SERVER_CONFIG,
  project: [{ id: 'proj', repo: 'user/repo', merge: null, agent: [[devAgent]] }],
};
const noopRunner = {
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  writeFile: async () => {},
};

let tempDir: string;
let agentStore: AgentStore;
let eventBus: EventBus;
const events: BaxianEvent[] = [];

type PollerOverrides = {
  config?: BaxianConfig;
  ensure?: () => Promise<string>;
  repoStoreFactory?: unknown;
  errorRecordStore?: ErrorRecordStore;
  intervalMs?: number;
  onPollComplete?: () => Promise<void>;
};

function makePoller(overrides: PollerOverrides = {}): BootstrapPoller {
  const {
    config: cfg = config, ensure, repoStoreFactory, errorRecordStore,
    intervalMs = 60_000, onPollComplete,
  } = overrides;
  return new BootstrapPoller({
    config: cfg,
    agentStore,
    eventBus,
    errorRecordStore,
    repoCache: createRepoStoreCache(),
    runnerFactory: () => noopRunner as never,
    repoStoreFactory: (repoStoreFactory ?? (() => ({ ensure: ensure ?? (async () => '/p') }))) as never,
    onPollComplete,
    intervalMs,
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-br-'));
  await initStateDir(tempDir);
  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  events.length = 0;
  eventBus.on('*', (e) => { events.push(e); });
});
afterEach(async () => { await rm(tempDir, { recursive: true }); });

describe('BootstrapPoller', () => {
  it('start/stop schedules and halts periodic ticks', async () => {
    vi.useFakeTimers();
    vi.spyOn(agentStore, 'update').mockResolvedValue(undefined);
    const ensure = vi.fn().mockResolvedValue('/repo/path');
    const poller = makePoller({ ensure });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(ensure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(ensure).toHaveBeenCalledTimes(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ensure).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does NOT emit agent.bootstrap_succeeded when no existing binding is updated', async () => {
    const poller = makePoller();
    await poller.pollOnce();
    expect(events.filter(e => e.type === 'agent.bootstrap_succeeded')).toHaveLength(0);
  });

  it('updates workdir and emits succeeded when an existing binding is updated', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    const poller = makePoller();
    await poller.pollOnce();
    expect((await agentStore.get('dev-1'))?.workdir).toBe('/p');
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(true);
  });

  it('multi-target allSettled: later targets run after one throws', async () => {
    const cfg2: BaxianConfig = {
      ...config,
      project: [
        { id: 'p1', repo: 'user/r1', merge: null, agent: [[{ ...devAgent, id: 'dev-1' }]] },
        { id: 'p2', repo: 'user/r2', merge: null, agent: [[{ ...devAgent, id: 'dev-2' }]] },
      ],
    };
    let ensureCalls = 0;
    const poller = makePoller({
      config: cfg2,
      repoStoreFactory: () => {
        ensureCalls++;
        const id = ensureCalls;
        return { ensure: async () => { if (id === 1) throw new Error('first down'); return '/p'; } };
      },
    });
    await poller.pollOnce();
    expect(ensureCalls).toBe(2);
  });

  it('passes the plain-git clone decision through BootstrapPoller', async () => {
    const repoStoreFactory = vi.fn(() => ({ ensure: async () => '/p' }));
    const customToolConfig: BaxianConfig = {
      ...config,
      project: [{
        ...config.project[0],
        repo: 'https://github.com/user/repo.git',
        gitCli: { tool: 'forge' },
      }],
    };
    const poller = makePoller({ config: customToolConfig, repoStoreFactory });

    await poller.pollOnce();

    expect(repoStoreFactory).toHaveBeenCalledTimes(1);
    expect(repoStoreFactory.mock.calls[0]?.[7]).toBe(false);
  });

  it('runs branch reconciliation after a completed poll', async () => {
    const onPollComplete = vi.fn().mockResolvedValue(undefined);
    const poller = makePoller({ onPollComplete });

    await poller.pollOnce();

    expect(onPollComplete).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated bootstrap_failed events for the same target and error', async () => {
    const poller = makePoller({ ensure: async () => { throw new Error('clone refused'); } });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(events.filter(e => e.type === 'agent.bootstrap_failed')).toHaveLength(1);
  });

  it('records bootstrap failures once per emitted failure event', async () => {
    const errorRecordStore = new ErrorRecordStore(join(tempDir, 'state', 'errors'));
    const poller = makePoller({
      errorRecordStore,
      ensure: async () => { throw new Error('clone refused'); },
    });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(await errorRecordStore.latestForAgent('dev-1')).toMatchObject({
      reason: 'BOOTSTRAP_REPO_ENSURE_FAILED',
      message: 'clone refused',
    });
  });

  it('reentrant pollOnce while previous in flight skips', async () => {
    let releaseEnsure!: () => void;
    const gate = new Promise<string>(r => { releaseEnsure = () => r('/p'); });
    const ensure = vi.fn().mockReturnValue(gate);
    const poller = makePoller({ ensure });
    const p1 = poller.pollOnce();
    const p2 = poller.pollOnce();
    releaseEnsure();
    await Promise.all([p1, p2]);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  describe('pollProject (user-triggered retry)', () => {
    const cfgTwoProjects: BaxianConfig = {
      github: {} as never, review: { rounds: 10 }, server: DEFAULT_SERVER_CONFIG,
      project: [
        { id: 'p-yes', repo: 'u/r1', merge: null, agent: [[{ ...devAgent, id: 'dev-yes' }]] },
        { id: 'p-no', repo: 'u/r2', merge: null, agent: [[{ ...devAgent, id: 'dev-no' }]] },
      ],
    };

    it('runs only the matching project (not the whole config)', async () => {
      const ensure = vi.fn().mockResolvedValue('/p');
      const poller = makePoller({ config: cfgTwoProjects, ensure });
      await poller.pollProject('p-yes');
      expect(ensure).toHaveBeenCalledTimes(1);
    });

    it('returns knownProject=false for unknown projectId so endpoint can distinguish 404 vs ran=0', async () => {
      const ensure = vi.fn().mockResolvedValue('/p');
      const poller = makePoller({ config: cfgTwoProjects, ensure });
      expect(await poller.pollProject('nope')).toEqual({ ok: false, ran: 0, knownProject: false });
      expect(ensure).not.toHaveBeenCalled();
    });

    it('returns knownProject=true + ran=0 + ok=true for project with no auto-mode agents (success no-op)', async () => {
      const cfgOnlyManual: BaxianConfig = {
        ...cfgTwoProjects,
        project: [{
          id: 'manual-only', repo: 'u/r3', merge: null,
          agent: [[{ ...devAgent, id: 'dev-m', workdir: '/manual' }]],
        }],
      };
      const ensure = vi.fn().mockResolvedValue('/p');
      const poller = makePoller({ config: cfgOnlyManual, ensure });
      expect(await poller.pollProject('manual-only')).toEqual({ ok: true, ran: 0, knownProject: true });
      expect(ensure).not.toHaveBeenCalled();
    });

    it('returns ok=false when the bootstrap actually fails', async () => {
      const ensure = vi.fn().mockRejectedValue(new Error('access denied'));
      const poller = makePoller({ config: cfgTwoProjects, ensure });
      expect(await poller.pollProject('p-yes')).toEqual({ ok: false, ran: 1, knownProject: true });
    });

    it('bypasses suppressFailureMessage dedup so the same error re-emits on retry', async () => {
      const ensure = vi.fn().mockRejectedValue(new Error('access denied'));
      const poller = makePoller({ config: cfgTwoProjects, ensure });
      await poller.pollOnce();
      events.length = 0;
      await poller.pollProject('p-yes');
      expect(events.filter(e => e.type === 'agent.bootstrap_failed')).toHaveLength(1);
    });
  });

  describe('replaceConfig reschedule', () => {
    it('clearing bootstrapRetryIntervalMs reverts to DEFAULT_BOOTSTRAP_RETRY_INTERVAL_MS (60s), not the stale runtime value', async () => {
      vi.useFakeTimers();
      vi.spyOn(agentStore, 'update').mockResolvedValue(undefined);
      const ensure = vi.fn().mockResolvedValue('/repo/path');
      const customConfig: BaxianConfig = {
        ...config,
        server: { ...config.server, bootstrapRetryIntervalMs: 5000 },
      };
      let resolveInitialPoll!: () => void;
      const initialPoll = new Promise<void>(resolve => { resolveInitialPoll = resolve; });
      const poller = makePoller({
        config: customConfig,
        ensure,
        intervalMs: 5000,
        onPollComplete: async () => { resolveInitialPoll(); },
      });
      poller.start();
      await initialPoll;
      const callsAtBoot = ensure.mock.calls.length;
      expect(callsAtBoot).toBeGreaterThan(0);

      poller.replaceConfig({
        ...customConfig,
        server: DEFAULT_SERVER_CONFIG,
      });

      await vi.advanceTimersByTimeAsync(59_999);
      expect(ensure.mock.calls.length).toBe(callsAtBoot);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(ensure.mock.calls.length).toBeGreaterThan(callsAtBoot);

      poller.stop();
      vi.useRealTimers();
    });

    it('reschedules timer when bootstrapRetryIntervalMs changes', async () => {
      vi.useFakeTimers();
      vi.spyOn(agentStore, 'update').mockResolvedValue(undefined);
      const ensure = vi.fn().mockResolvedValue('/repo/path');
      const baseConfig: BaxianConfig = {
        ...config,
        server: { ...config.server, bootstrapRetryIntervalMs: 2000 },
      };
      const poller = makePoller({ config: baseConfig, ensure, intervalMs: 2000 });
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(ensure).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(0);
      expect(ensure).toHaveBeenCalledTimes(2);

      poller.replaceConfig({
        ...baseConfig,
        server: { ...baseConfig.server, bootstrapRetryIntervalMs: 7000 },
      });

      await vi.advanceTimersByTimeAsync(6999);
      expect(ensure).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(ensure).toHaveBeenCalledTimes(3);

      poller.stop();
      vi.useRealTimers();
    });
  });
});
