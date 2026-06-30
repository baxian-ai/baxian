import type { BaxianConfig, AgentConfig, ProjectConfig, BaxianEvent, HostConfig } from '../shared/index.js';
import { isGitHubRepo, parseGitRemote, redactGitCredentials } from '../shared/index.js';
import type { AgentStore } from '../state/agent-store.js';
import type { ErrorRecordStore } from '../state/error-record-store.js';
import type { EventBus } from '../event/bus.js';
import type { CommandRunner } from './runner.js';
import { createRunner, resolveAgentHost, hostGroupKey } from './runner.js';
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
    for (const pair of project.agent) {
      for (const agent of pair) {
        if (agent.workdir) continue;
        ids.add(agent.id);
      }
    }
  }
  return ids;
}

export function collectTargets(config: BaxianConfig): BootstrapTarget[] {
  const groups = new Map<string, BootstrapTarget>();
  for (const project of config.project) {
    for (const pair of project.agent) {
      for (const agent of pair) {
        if (agent.workdir) continue;
        const resolvedHost = resolveAgentHost(config.host, agent.host);
        const key = `${project.id}::${hostGroupKey(agent.mode, resolvedHost)}`;
        const existing = groups.get(key);
        if (existing) {
          existing.agents.push(agent);
        } else {
          groups.set(key, { project, agents: [agent], representativeAgent: agent, resolvedHost });
        }
      }
    }
  }
  return Array.from(groups.values());
}

export async function runSingleTarget(
  target: BootstrapTarget,
  deps: BootstrapDeps,
  opts: RunSingleTargetOptions,
): Promise<RunSingleTargetResult> {
  let repoPath: string | null = null;
  let ensureError: Error | null = null;
  try {
    const rep = target.representativeAgent;
    const runner = deps.runnerFactory
      ? deps.runnerFactory(rep)
      : createRunner(rep.mode, target.resolvedHost);
    const repoStore = deps.repoStoreFactory
      ? deps.repoStoreFactory(runner, target.project.repo, rep.mode, target.resolvedHost, deps.repoCache)
      : new RepoStore(runner, target.project.repo, rep.mode, target.resolvedHost, deps.repoCache);
    repoPath = await repoStore.ensure();
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
          return { ...existing, ...(repoPath ? { repoPath } : {}), updatedAt: now };
        });
        if (wasUpdated) updated++;
      } catch (writeErr) {
        console.error(`[bootstrap] failed to write repoPath for ${agent.id}:`, writeErr);
      }
    }
    if (updated > 0 || opts.emitOnUnchanged) {
      await safeEmit(deps.eventBus, {
        id: '',
        type: 'agent.bootstrap_succeeded',
        timestamp: now,
        projectId: target.project.id,
        data: { repoPath, agentIds: affectedAgentIds, updated },
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

const STRONG_ACCESS_PATTERNS = [
  /could not resolve to a repository/i,
  /repository not found/i,
  /\bGraphQL:/,
];

const GENERIC_AUTH_PATTERNS = [
  /permission denied/i,
  /authentication failed/i,
  /access denied/i,
  /\b(HTTP\s+)?404\b/,
];

const GITHUB_CONTEXT_PATTERNS = [
  /github\.com/i,
  /\bgit@/,
  /\(publickey\)/i,
  /gh repo/i,
  /^gh:\s/m,
];

export function classifyBootstrapError(message: string, repo: string): {
  reason: string;
  message: string;
  recommendation: string;
} {
  if (!isGitHubRepo(repo)) return classifyGenericGitError(message, repo);
  const accessDenied = STRONG_ACCESS_PATTERNS.some(re => re.test(message))
    || (GENERIC_AUTH_PATTERNS.some(re => re.test(message))
        && GITHUB_CONTEXT_PATTERNS.some(re => re.test(message)));
  if (accessDenied) {
    return {
      reason: 'BOOTSTRAP_REPO_ACCESS_DENIED',
      message: `GitHub repo "${repo}" not found or access denied (underlying error: ${message}).`,
      recommendation: `Verify the repo URL and grant the host's gh account collaborator access to "${repo}", then retry.`,
    };
  }
  return {
    reason: 'BOOTSTRAP_REPO_ENSURE_FAILED',
    message,
    recommendation: 'Check repository access and retry bootstrap.',
  };
}

function classifyGenericGitError(message: string, repo: string): {
  reason: string;
  message: string;
  recommendation: string;
} {
  const host = parseGitRemote(repo)?.host;
  const gitContext = /(?:https?|ssh):\/\//i.test(message)
    || /\bgit@/.test(message)
    || /\(publickey\)/i.test(message);
  const accessDenied = gitContext && (
    GENERIC_AUTH_PATTERNS.some(re => re.test(message))
    || /could not read (?:Username|Password)/i.test(message)
    || /\brepository\b[\s\S]*?\bnot found\b/i.test(message)
    || /could not be found/i.test(message)
  );
  if (accessDenied) {
    return {
      reason: 'BOOTSTRAP_REPO_ACCESS_DENIED',
      message: redactGitCredentials(`Repo "${repo}" not found or access denied (underlying error: ${message}).`),
      recommendation:
        `Verify the repo URL and the git credentials (HTTPS credential helper or SSH key) for ` +
        `${host ?? 'this host'}, then retry.`,
    };
  }
  return {
    reason: 'BOOTSTRAP_REPO_ENSURE_FAILED',
    message,
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
