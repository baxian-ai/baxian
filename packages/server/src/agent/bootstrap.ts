import type { BaxianConfig, AgentConfig, ProjectConfig, BaxianEvent, HostConfig } from '../shared/index.js';
import { redactGitCredentials } from '../shared/index.js';
import type { AgentStore } from '../state/agent-store.js';
import type { ErrorRecordStore } from '../state/error-record-store.js';
import type { EventBus } from '../event/bus.js';
import type { CommandRunner } from './runner.js';
import { createRunner, resolveAgentHost } from './runner.js';
import { RepoStore, type RepoStoreCache } from './repo-store.js';
import { AGENT_STORE_NOOP } from '../state/agent-store.js';

export interface BootstrapDeps {
  config: BaxianConfig;
  agentStore: AgentStore;
  eventBus: EventBus;
  repoCache: RepoStoreCache;
  errorRecordStore?: ErrorRecordStore;
  runnerFactory?: (agent: AgentConfig) => CommandRunner;
  repoStoreFactory?: (
    runner: CommandRunner,
    repo: string,
    mode: AgentConfig['mode'],
    host: HostConfig | undefined,
    cache: RepoStoreCache,
    agentId: string,
    workdir?: string,
  ) => RepoStore;
  onAgentAffected?: (agentIds: string[]) => void;
}

export interface BootstrapTarget {
  project: ProjectConfig;
  agents: AgentConfig[];
  representativeAgent: AgentConfig;
  resolvedHost?: HostConfig;
}

export interface RunSingleTargetOptions {
  emitOnUnchanged: boolean;
  suppressFailureMessage?: string;
}

export interface RunSingleTargetResult {
  ok: boolean;
  failureMessage?: string;
}

export async function bootstrapAutoRepos(deps: BootstrapDeps): Promise<void> {
  const targets = collectTargets(deps.config);
  await Promise.allSettled(
    targets.map(target => runSingleTarget(target, deps, { emitOnUnchanged: true })),
  );
}

export function autoBootstrapAgentIds(config: BaxianConfig): Set<string> {
  const ids = new Set<string>();
  for (const project of config.project) {
    for (const team of project.agent) {
      for (const agent of team) {
        if (agent.workdir) continue;
        ids.add(agent.id);
      }
    }
  }
  return ids;
}

export function collectTargets(config: BaxianConfig): BootstrapTarget[] {
  const targets: BootstrapTarget[] = [];
  for (const project of config.project) {
    for (const team of project.agent) {
      for (const agent of team) {
        if (agent.workdir) continue;
        const resolvedHost = resolveAgentHost(config.host, agent.host);
        targets.push({ project, agents: [agent], representativeAgent: agent, resolvedHost });
      }
    }
  }
  return targets;
}

export async function runSingleTarget(
  target: BootstrapTarget,
  deps: BootstrapDeps,
  opts: RunSingleTargetOptions,
): Promise<RunSingleTargetResult> {
  let workdir: string | null = null;
  let ensureError: Error | null = null;
  const rep = target.representativeAgent;
  try {
    const runner = deps.runnerFactory
      ? deps.runnerFactory(rep)
      : createRunner(rep.mode, target.resolvedHost);
    const repoStore = deps.repoStoreFactory
      ? deps.repoStoreFactory(
          runner, target.project.repo, rep.mode, target.resolvedHost, deps.repoCache, rep.id, rep.workdir,
        )
      : new RepoStore(
          runner, target.project.repo, rep.mode, target.resolvedHost, deps.repoCache, rep.id, rep.workdir,
        );
    workdir = await repoStore.ensure();
  } catch (err) {
    ensureError = err instanceof Error ? err : new Error(String(err));
  }

  const now = new Date().toISOString();

  const affectedAgentIds = target.agents.map(a => a.id);
  if (ensureError === null) {
    let updated = 0;
    for (const agent of target.agents) {
      try {
        let wasUpdated = false;
        await deps.agentStore.update(agent.id, (existing) => {
          if (!existing) return AGENT_STORE_NOOP;
          wasUpdated = true;
          return { ...existing, ...(workdir ? { workdir } : {}), updatedAt: now };
        });
        if (wasUpdated) updated++;
      } catch (writeErr) {
        console.error(`[bootstrap] failed to write workdir for ${agent.id}:`, writeErr);
      }
    }
    if (updated > 0 || opts.emitOnUnchanged) {
      await safeEmit(deps.eventBus, {
        id: '',
        type: 'agent.bootstrap_succeeded',
        timestamp: now,
        projectId: target.project.id,
        data: { workdir, agentIds: affectedAgentIds, updated },
      });
    }
    let bootstrapErrorPurged = 0;
    if (deps.errorRecordStore) {
      for (const id of affectedAgentIds) {
        try {
          const purgeResult = await deps.errorRecordStore.purgeBootstrapForAgent(id);
          bootstrapErrorPurged += purgeResult.removed;
        } catch (err) {
          console.warn(`[bootstrap] purgeBootstrapForAgent failed for ${id}:`, err);
        }
      }
    }
    if (bootstrapErrorPurged > 0 || opts.emitOnUnchanged) {
      deps.onAgentAffected?.(affectedAgentIds);
    }
    return { ok: true };
  }

  const message = ensureError.message;
  if (message !== opts.suppressFailureMessage) {
    await recordBootstrapFailure(target, deps, message, now);
    await safeEmit(deps.eventBus, {
      id: '',
      type: 'agent.bootstrap_failed',
      timestamp: now,
      projectId: target.project.id,
      data: { error: message, agentIds: affectedAgentIds },
    });
    console.warn(`[bootstrap] retry failed for ${target.project.id}: ${message}`);
    deps.onAgentAffected?.(affectedAgentIds);
  }
  return { ok: false, failureMessage: message };
}

const REPOSITORY_ACCESS_PATTERNS = [
  /repository(?:[^\n]*?)not found/i,
  /could not read (?:Username|Password)/i,
  /authentication failed/i,
  /permission denied \(publickey\)/i,
];

const AMBIGUOUS_ACCESS_PATTERNS = [
  /permission denied/i,
  /access denied/i,
  /\b(?:HTTP\s+)?(?:401|403|404)\b/i,
];

const GIT_ACCESS_CONTEXT_PATTERNS = [
  /\bgit (?:clone|fetch|ls-remote)\b/i,
  /(?:https?|ssh):\/\//i,
  /\bgit@/i,
  /\(publickey\)/i,
];

export function classifyBootstrapError(message: string, repo: string): {
  reason: string;
  message: string;
  recommendation: string;
} {
  const safeMessage = redactGitCredentials(message);
  const localFilesystemFailure = /\b(?:EACCES|EPERM)\b/i.test(message)
    || /permission denied[\s\S]*?\b(?:mkdir|open|write|unlink|rename)\b/i.test(message);
  const accessDenied = !localFilesystemFailure
    && (REPOSITORY_ACCESS_PATTERNS.some(re => re.test(message))
      || (AMBIGUOUS_ACCESS_PATTERNS.some(re => re.test(message))
        && GIT_ACCESS_CONTEXT_PATTERNS.some(re => re.test(message))));
  if (accessDenied) {
    return {
      reason: 'BOOTSTRAP_REPO_ACCESS_DENIED',
      message: `Repository "${redactGitCredentials(repo)}" not found or access denied (underlying error: ${safeMessage}).`,
      recommendation: 'Verify the repo URL and this host\'s HTTPS credential helper or SSH key, then retry.',
    };
  }
  return {
    reason: 'BOOTSTRAP_REPO_ENSURE_FAILED',
    message: safeMessage,
    recommendation: 'Check repository access and retry bootstrap.',
  };
}

async function recordBootstrapFailure(
  target: BootstrapTarget,
  deps: BootstrapDeps,
  message: string,
  occurredAt: string,
): Promise<void> {
  if (!deps.errorRecordStore) return;
  const classified = classifyBootstrapError(message, target.project.repo);
  await Promise.allSettled(target.agents.map(agent => deps.errorRecordStore!.append({
    agentId: agent.id,
    projectId: target.project.id,
    operation: 'bootstrap',
    reason: classified.reason,
    message: classified.message,
    occurredAt,
    recommendation: classified.recommendation,
  })));
}

async function safeEmit(bus: EventBus, event: BaxianEvent): Promise<void> {
  try {
    await bus.emit(event);
  } catch (err) {
    console.warn(`[bootstrap] safeEmit ${event.type} failed (audit log loss; state machine unaffected):`, err);
  }
}
