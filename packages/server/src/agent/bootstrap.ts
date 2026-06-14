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
  // Notification hook for EventPublisher. Bootstrap failures/successes only touch
  // errorRecordStore / eventBus (audit log), not agentStore — without this hook open
  // agents-topic subscribers would keep the stale snapshot and the new "Retry bootstrap"
  // button's toast would point at a red card that never updates.
  onAgentAffected?: (agentIds: string[]) => void;
}

export interface BootstrapTarget {
  project: ProjectConfig;
  agents: AgentConfig[];
  representativeAgent: AgentConfig;
  // Registry host resolved against the config that produced this target (undefined for local).
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

// Set of agent ids that are subject to bootstrap (auto-mode = no explicit workdir). Used by
// the sweep path in startup / config-replace to filter stale bootstrap errors for agents that
// no longer participate in bootstrap (either deleted or transitioned to explicit workdir).
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
        // Resolve the host ref so agents sharing one machine (same id, or different ids → same
        // hostname:port:user) collapse to one RepoStore.hostKey-matching group.
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
    // Truth source for the red card is "is there a current bootstrap error record?". Purge stale
    // failures so retries that succeed actually clear the card — covers (a) never-dispatched
    // agents that have no binding for repoPath-based gating to work on, and (b) post-first-success
    // failure → retry → success cycles where binding.repoPath was set long ago and isn't temporal.
    // purgeBootstrapForAgent uses an internal substring quickCheck so the no-stale common case
    // is just one readFile per jsonl with no parse/rewrite, and returns removed count so we can
    // gate the downstream snapshot publish on actual state change (not synthetic noop publishes).
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
    // Notify only for state changes that bypass agentStore. Binding updates (updated > 0) already
    // fire AgentStore.onChange → eventPublisher.publishAgentChange in production wiring; calling
    // onAgentAffected here too would double-publish the same snapshot. The two cases that *do*
    // need this hook are (a) bootstrap error cleared without touching agentStore (red card just
    // disappeared from the snapshot but agentStore is untouched), (b) manual retry which wants a
    // fresh signal regardless. Steady-state success is a no-op.
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

// Strong, GitHub-specific failure signatures from `gh repo clone` / GraphQL — no risk of
// false-matching local errors. These alone justify the "grant collaborator access" hint.
//
// Intentionally NOT including bare `/\bgh:\s/i` — `gh: command not found`, `gh: API rate limit
// exceeded`, etc. are gh CLI runtime/tooling errors, not repo access denials, and would mislead
// operators toward fixing repo permissions instead of installing/authenticating gh.
const STRONG_ACCESS_PATTERNS = [
  /could not resolve to a repository/i,
  /repository not found/i,
  /\bGraphQL:/,
];

// Generic auth/permission keywords that ALSO match local OS errors (mkdir EACCES, etc.).
// Only treat as ACCESS_DENIED when paired with a GitHub-context signal (see GITHUB_CONTEXT_PATTERNS).
const GENERIC_AUTH_PATTERNS = [
  /permission denied/i,
  /authentication failed/i,
  /access denied/i,
  /\b(HTTP\s+)?404\b/,
];

// Markers that the failing operation was actually talking to GitHub (vs. local fs / unrelated
// network). Required to disambiguate `Permission denied` from a real gh-permission issue vs.
// a local `mkdir EACCES`.
// `/^gh:\s/m` (line-start) lets `gh: Not Found (HTTP 404)` upgrade to ACCESS_DENIED via the
// 404 generic, but stops `sh: gh: command not found` from matching because there gh: isn't at
// line start (the runtime shell prefix wins).
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
  // Non-GitHub repos clone via plain `git` (no gh/GraphQL) — different failure signatures.
  if (!isGitHubRepo(repo)) return classifyGenericGitError(message, repo);
  // Intentionally do NOT use `message.includes(repo)` as a GitHub-context signal — local
  // mkdir/path errors embed the repo string in filesystem paths (e.g. `/var/baxian/repos/<repo>`)
  // and would false-match. Trust only the explicit GitHub markers below.
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

// Generic `git clone` (non-GitHub) failure classification. git-context signals (URL scheme,
// scp `git@`, publickey) gate the auth keywords; a scheme/`git@` never appears in a local
// fs path (unlike the repos-ext/<host> dir), so this won't false-match local mkdir errors.
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
    // remote repository-not-found ONLY — never a shell missing-binary ("command not found", or
    // dash's "git: not found"), which is an env problem (ENSURE_FAILED), not a credentials one.
    || /\brepository\b[\s\S]*?\bnot found\b/i.test(message)
    || /could not be found/i.test(message)
  );
  if (accessDenied) {
    return {
      reason: 'BOOTSTRAP_REPO_ACCESS_DENIED',
      // redact: repo / underlying error may carry an embedded token before it lands in the error record.
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
