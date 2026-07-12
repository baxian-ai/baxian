import type { BaxianConfig, AgentConfig } from '../shared/index.js';
import type { AgentStore } from '../state/agent-store.js';
import type { EventBus } from '../event/bus.js';
import type { ErrorRecordStore } from '../state/error-record-store.js';
import type { CommandRunner } from './runner.js';
import { hostGroupKey } from './runner.js';
import type { RepoStore, RepoStoreCache } from './repo-store.js';
import { collectTargets, runSingleTarget } from './bootstrap.js';
import { PeriodicTaskRunner } from '../timing/periodic-task-runner.js';

export interface BootstrapPollerOptions {
  config: BaxianConfig;
  agentStore: AgentStore;
  eventBus: EventBus;
  repoCache: RepoStoreCache;
  errorRecordStore?: ErrorRecordStore;
  runnerFactory?: (agent: AgentConfig) => CommandRunner;
  repoStoreFactory?: (
    runner: CommandRunner,
    repoSlug: string,
    mode: AgentConfig['mode'],
    host: AgentConfig['host'],
    cache: RepoStoreCache,
    agentId: string,
    workdir?: string,
  ) => RepoStore;
  onAgentAffected?: (agentIds: string[]) => void;
  onPollComplete?: () => Promise<void>;
  intervalMs?: number;
}

export class BootstrapPoller {
  private readonly periodicRunner: PeriodicTaskRunner;
  private opts: BootstrapPollerOptions;
  private lastFailureByTarget = new Map<string, string>();
  private pollIntervalMs: number;

  constructor(options: BootstrapPollerOptions) {
    this.opts = options;
    this.pollIntervalMs = options.intervalMs
      ?? options.config.server.bootstrapRetryIntervalMs;
    this.periodicRunner = new PeriodicTaskRunner({
      name: 'bootstrap-poller',
      intervalMs: this.pollIntervalMs,
      run: () => this.pollTargets(),
    });
  }

  replaceConfig(validated: BaxianConfig): void {
    this.opts = { ...this.opts, config: validated };
    const validKeys = new Set(collectTargets(validated).map(targetKey));
    for (const key of [...this.lastFailureByTarget.keys()]) {
      if (!validKeys.has(key)) this.lastFailureByTarget.delete(key);
    }
    const nextIntervalMs = validated.server.bootstrapRetryIntervalMs;
    if (nextIntervalMs !== this.pollIntervalMs) {
      this.pollIntervalMs = nextIntervalMs;
      this.periodicRunner.reschedule(nextIntervalMs);
    }
  }

  start(): void {
    this.periodicRunner.start({ runImmediately: true });
  }

  stop(): void {
    this.periodicRunner.stop();
  }

  async pollOnce(): Promise<void> {
    await this.periodicRunner.runOnce();
  }

  async pollProject(projectId: string): Promise<{ ok: boolean; ran: number; knownProject: boolean }> {
    const knownProject = this.opts.config.project.some(p => p.id === projectId);
    if (!knownProject) return { ok: false, ran: 0, knownProject: false };
    const targets = collectTargets(this.opts.config).filter(t => t.project.id === projectId);
    if (targets.length === 0) return { ok: true, ran: 0, knownProject: true };
    let allOk = true;
    await Promise.allSettled(
      targets.map(async (target) => {
        const key = targetKey(target);
        const result = await runSingleTarget(target, this.opts, { emitOnUnchanged: true });
        if (result.ok) {
          this.lastFailureByTarget.delete(key);
        } else {
          allOk = false;
          if (result.failureMessage) this.lastFailureByTarget.set(key, result.failureMessage);
        }
      }),
    );
    await this.opts.onPollComplete?.();
    return { ok: allOk, ran: targets.length, knownProject: true };
  }

  private async pollTargets(): Promise<void> {
    const targets = collectTargets(this.opts.config);
    await Promise.allSettled(
      targets.map(async (target) => {
        const key = targetKey(target);
        const result = await runSingleTarget(target, this.opts, {
          emitOnUnchanged: false,
          suppressFailureMessage: this.lastFailureByTarget.get(key),
        });
        if (result.ok) {
          this.lastFailureByTarget.delete(key);
        } else if (result.failureMessage) {
          this.lastFailureByTarget.set(key, result.failureMessage);
        }
      }),
    );
    await this.opts.onPollComplete?.();
  }
}

function targetKey(target: ReturnType<typeof collectTargets>[number]): string {
  const agent = target.representativeAgent;
  return `${target.project.id}:${target.project.repo}:${agent.id}:${agent.mode}:${hostGroupKey(agent.mode, target.resolvedHost)}`;
}
