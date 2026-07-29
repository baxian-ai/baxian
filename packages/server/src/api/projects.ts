import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import type {
  AgentMode,
  AgentBindingFacts,
  BaxianConfig,
  ProjectConfig,
  MergeStrategy,
  SpecApprovalStrategy,
  AgentConfig,
} from '../shared/index.js';
import {
  TASK_ACTIVE_STATUS_SET,
  TASK_OWNER_ROLES,
  TASK_TERMINAL_STATUS_SET,
} from '../shared/index.js';
import { probeTmux, runPreflight, type PreflightResult } from '../agent/preflight.js';
import { installTmux } from '../agent/tmux-install.js';
import {
  createRunner,
  hostGroupKey,
  mayShareHostAccount,
  resolveAgentHost,
  type CommandRunner,
} from '../agent/runner.js';
import { saveConfig, prepareConfig, ConfigValidationError } from '../config/loader.js';
import { withConfigLock } from '../config/mutex.js';
import { redactProjects } from './config.js';
import { CleanupFailedError, type DeletionClaimOutcome } from '../agent/manager.js';
import { AGENT_STORE_NOOP } from '../state/agent-store.js';
import { applyConfigHotReload, prepareConfigHotReload } from '../config/hot-reload.js';
import { gitBindingBlockerDetails, gitBindingBlockers } from './platform-guard.js';
import { safeDriverErrorText } from '../platform/git-driver.js';
import { projectNeedsPlatformEntry } from '../config/validator.js';

interface CheckRun {
  agentId: string;
  mode: AgentMode;
  results: PreflightResult[];
}

interface CheckEntry {
  agent: AgentConfig;
  hostGroup: string;
  runner: CommandRunner;
}

interface TmuxFix {
  hostGroup: string;
  ok: boolean;
  method?: string;
  version?: string;
  message: string;
}

async function fixMissingTmux(
  projectId: string,
  entries: CheckEntry[],
  agents: CheckRun[],
): Promise<TmuxFix[]> {
  const runsById = new Map(agents.map(run => [run.agentId, run]));
  const groups = new Map<string, { runner: CommandRunner; agentIds: string[] }>();
  for (const { agent, hostGroup, runner } of entries) {
    const tmuxCheck = runsById.get(agent.id)?.results.find(r => r.step === 'tmux');
    if (!tmuxCheck || tmuxCheck.ok) continue;
    const group = groups.get(hostGroup);
    if (group) group.agentIds.push(agent.id);
    else groups.set(hostGroup, { runner, agentIds: [agent.id] });
  }

  const fixes: TmuxFix[] = [];
  for (const [hostGroup, group] of groups) {
    const install = await installTmux(group.runner);
    fixes.push({
      hostGroup,
      ok: install.ok,
      method: install.method,
      version: install.version,
      message: install.message,
    });
    if (!install.ok) continue;
    const reprobe = await probeTmux(group.runner, projectId);
    for (const agentId of group.agentIds) {
      const run = runsById.get(agentId);
      const index = run ? run.results.findIndex(r => r.step === 'tmux') : -1;
      if (run && index >= 0) run.results[index] = reprobe;
    }
  }
  return fixes;
}

async function runServerHostChecks(
  agentManager: import('../agent/manager.js').AgentManager,
  projectId: string,
): Promise<PreflightResult[]> {
  const driver = agentManager.platformDriverFor(projectId);
  if (!driver) {
    return [{ step: 'driver', ok: false, message: 'no git driver resolvable for this project on the server host' }];
  }
  let results: PreflightResult[];
  try {
    results = await driver.runPreflightSteps();
  } catch (err) {
    console.warn('[checks] server-host driver preflight failed:', safeDriverErrorText(err));
    return [{ step: 'driver-preflight', ok: false, message: safeDriverErrorText(err) }];
  }
  if (results.some(r => !r.ok)) return results;
  try {
    const [row] = await driver.runOp('projectView');
    results.push({ step: 'platform-repo', ok: true, message: 'driver projectView OK on the server host' });
    const push = row?.pushPermitted;
    results.push(push === true
      ? { step: 'platform-push', ok: true, message: 'push permission confirmed (server merge/close channel)' }
      : push === false
        ? { step: 'platform-push', ok: false, message: 'push permission missing — server merge/close requires write access' }
        : { step: 'platform-push', ok: true, message: 'plugin did not report pushPermitted — write access cannot be asserted statically' });
  } catch (err) {
    console.warn('[checks] server-host projectView failed:', safeDriverErrorText(err));
    results.push({
      step: 'platform-repo',
      ok: false,
      message: `driver projectView failed on the server host — ${safeDriverErrorText(err)}`,
    });
  }
  return results;
}

function configHash(config: BaxianConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function omitAgentsFromProject(config: BaxianConfig, projectId: string, removed: string[]): BaxianConfig {
  const removedSet = new Set(removed);
  return {
    ...config,
    project: config.project.map(p => {
      if (p.id !== projectId) return p;
      return {
        ...p,
        agent: p.agent
          .map(pair => pair.filter(a => !removedSet.has(a.id)))
          .filter(pair => pair.length > 0),
      };
    }),
  };
}

type RemovalRotationOutcome =
  | { ok: true }
  | { ok: false; code: 'locked' | 'stale-binding' | 'claim-changed'; agentId: string };

class AgentRemovalTransaction {
  private readonly owner: string;
  private readonly ownerLabel: string;
  private readonly originalStates = new Map<string, AgentBindingFacts | null>();
  private readonly rotatedClaims = new Map<string, {
    deletionToken: string;
    original: { taskId: string; token: string } | null;
  }>();
  private claimed = false;
  private committed = false;

  constructor(
    private readonly app: FastifyInstance,
    readonly targets: readonly string[],
    private readonly operation: 'PUT' | 'DELETE',
  ) {
    const ownerPrefix = operation === 'DELETE' ? 'deletion' : 'replacement';
    this.owner = `${ownerPrefix}:${randomUUID()}`;
    this.ownerLabel = ownerPrefix === 'deletion' ? 'deletion-owner' : 'replacement owner';
  }

  async claim(): Promise<DeletionClaimOutcome> {
    const outcome = await this.app.ctx.agentManager.scanOpenThenClaimDeletion(this.targets);
    if (outcome.ok) this.claimed = true;
    return outcome;
  }

  async rotateClaims(): Promise<RemovalRotationOutcome> {
    for (const agentId of this.targets) {
      const state = await this.app.ctx.agentStore.get(agentId);
      this.originalStates.set(agentId, state);
      const claim = await this.app.ctx.lockManager.claimOf(agentId);
      if (claim && !state?.taskId) {
        await this.rollbackClaims();
        return { ok: false, code: 'locked', agentId };
      }
      if (claim && claim.taskId !== state!.taskId) {
        await this.rollbackClaims();
        return { ok: false, code: 'stale-binding', agentId };
      }
      const deletionToken = randomUUID();
      const original = claim ? { taskId: claim.taskId, token: claim.token } : null;
      const acquired = await this.app.ctx.lockManager.rotateClaim(
        agentId,
        original ?? { unbound: true },
        { taskId: this.owner, token: deletionToken },
      );
      if (!acquired) {
        await this.rollbackClaims();
        const code = original || this.operation === 'PUT' ? 'claim-changed' : 'locked';
        return { ok: false, code, agentId };
      }
      this.rotatedClaims.set(agentId, { deletionToken, original });
    }
    return { ok: true };
  }

  async rollbackStateAndClaims(): Promise<Error | null> {
    const failures: Error[] = [];
    const claimError = await this.rollbackClaimsForRetry();
    if (claimError) failures.push(claimError);
    try {
      await this.restoreStates();
    } catch (err) {
      failures.push(err instanceof Error ? err : new Error(String(err)));
    }
    if (failures.length === 0) return null;
    return failures.length === 1
      ? failures[0]!
      : new AggregateError(failures, 'Agent removal rollback failed');
  }

  async rollbackClaimsForRetry(): Promise<Error | null> {
    try {
      await this.rollbackClaims();
      return null;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  async finalizeCommit(
    config: BaxianConfig,
    opts: {
      beforeConfigSwitch?: (warnings: string[]) => Promise<void>;
      divergenceTargets?: readonly string[];
    } = {},
  ): Promise<{ restartRequired: boolean; warnings: string[] }> {
    this.committed = true;
    for (const agentId of this.targets) this.app.ctx.agentManager.bumpDeletionGeneration(agentId);
    const warnings: string[] = [];
    for (const agentId of this.targets) {
      try {
        await this.app.ctx.agentStore.delete(agentId);
      } catch (err) {
        const warning = this.operation === 'PUT'
          ? `old agent ${agentId} state delete failed post-commit: ${err instanceof Error ? err.message : String(err)}`
          : `agent ${agentId} state delete failed post-commit (reclaimable orphan state): ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(warning);
        this.app.log.error(
          { err, agentId, targets: this.targets },
          `${this.operation} /agents${this.operation === 'DELETE' ? ' Phase 3' : ''} ${warning}`,
        );
      }
    }
    await opts.beforeConfigSwitch?.(warnings);
    const switchResult = switchCommittedAgentConfig(
      this.app,
      config,
      opts.divergenceTargets ?? this.targets,
      this.operation,
    );
    if (switchResult.warning) warnings.push(switchResult.warning);
    for (const agentId of this.targets) {
      try {
        await this.releaseClaim(agentId);
      } catch (err) {
        const warning = this.operation === 'PUT'
          ? `replacement lock release for ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`
          : `lock release for ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(warning);
        this.app.log.warn(
          { err, agentId },
          `${this.operation} /agents ${this.operation === 'DELETE' ? 'Phase 3 lock release failed (post-commit)' : warning}`,
        );
      }
      if (this.app.ctx.errorRecordStore) {
        try {
          await this.app.ctx.errorRecordStore.purgeAgent(agentId);
        } catch (err) {
          const warning = `error history cleanup for ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`;
          if (this.operation === 'PUT') warnings.push(warning);
          this.app.log.warn(
            { err, agentId },
            this.operation === 'PUT' ? `PUT /agents ${warning}` : 'DELETE /agents errorRecordStore.purgeAgent failed',
          );
        }
      }
      if (this.app.ctx.petStore) {
        try {
          await this.app.ctx.petStore.setAssignment(agentId, null);
        } catch (err) {
          const warning = `pet assignment cleanup for ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`;
          if (this.operation === 'PUT') warnings.push(warning);
          this.app.log.warn(
            { err, agentId },
            this.operation === 'PUT' ? `PUT /agents ${warning}` : 'DELETE /agents petStore.setAssignment(null) failed',
          );
        }
      }
    }
    return { restartRequired: switchResult.restartRequired, warnings };
  }

  private async releaseClaim(agentId: string): Promise<void> {
    if (!(await this.settleClaim(agentId, false))) {
      throw new Error(`${this.ownerLabel} claim changed before release`);
    }
  }

  async finish(): Promise<void> {
    try {
      if (this.rotatedClaims.size > 0) {
        await this.settleClaims(!this.committed);
      }
    } finally {
      if (this.claimed) {
        this.app.ctx.agentManager.releaseDeletionClaim(this.targets);
        this.claimed = false;
      }
    }
  }

  private async rollbackClaims(): Promise<void> {
    await this.settleClaims(true);
  }

  private async settleClaims(restoreOriginal: boolean): Promise<void> {
    const failures: Error[] = [];
    for (const agentId of [...this.rotatedClaims.keys()]) {
      try {
        if (!(await this.settleClaim(agentId, restoreOriginal))) {
          failures.push(new Error(
            `${agentId}: ${this.ownerLabel} claim no longer held; ` +
            (restoreOriginal ? 'original owner not restored' : 'claim not released'),
          ));
        }
      } catch (err) {
        failures.push(new Error(`${agentId}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `lock ${restoreOriginal ? 'rollback' : 'release'} failed for ${failures.length} target(s)`,
      );
    }
  }

  private async settleClaim(agentId: string, restoreOriginal: boolean): Promise<boolean> {
    const rotated = this.rotatedClaims.get(agentId);
    if (!rotated) return true;
    const settled = restoreOriginal && rotated.original
      ? await this.app.ctx.lockManager.rotateClaim(
          agentId,
          { taskId: this.owner, token: rotated.deletionToken },
          rotated.original,
        )
      : await this.app.ctx.lockManager.releaseIfOwner(
          agentId,
          this.owner,
          rotated.deletionToken,
        );
    if (settled) this.rotatedClaims.delete(agentId);
    return settled;
  }

  private async restoreStates(): Promise<void> {
    const failures: Error[] = [];
    for (const agentId of this.targets) {
      try {
        const original = this.originalStates.get(agentId) ?? null;
        if (!original) {
          await this.app.ctx.agentStore.delete(agentId);
          continue;
        }
        let lockToken = original.lockToken;
        if (original.taskId) {
          const claim = await this.app.ctx.lockManager.claimOf(agentId);
          if (claim?.taskId === original.taskId) {
            lockToken = claim.token;
          } else if (claim === null) {
            lockToken = await this.app.ctx.lockManager.acquire(agentId, original.taskId) ?? undefined;
          } else {
            throw new Error(`lock is owned by ${claim.taskId}, expected ${original.taskId}`);
          }
          if (!lockToken || !(await this.app.ctx.lockManager.isOwner(agentId, original.taskId, lockToken))) {
            throw new Error(`could not restore exact task lock for ${original.taskId}`);
          }
        }
        await this.app.ctx.agentStore.set({
          ...original,
          ...(original.taskId ? { lockToken } : { lockToken: undefined }),
          paneId: undefined,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        failures.push(new Error(`${agentId}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to roll back ${failures.length} agent removal state(s)`);
    }
  }
}

async function restoreAgentStateSnapshots(
  app: FastifyInstance,
  snapshots: ReadonlyMap<string, AgentBindingFacts | null>,
): Promise<Error | null> {
  const failures: Error[] = [];
  for (const [agentId, snapshot] of [...snapshots].reverse()) {
    try {
      if (snapshot) await app.ctx.agentStore.set(snapshot);
      else await app.ctx.agentStore.delete(agentId);
    } catch (err) {
      failures.push(new Error(`${agentId}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  if (failures.length === 0) return null;
  return failures.length === 1
    ? failures[0]!
    : new AggregateError(failures, `Failed to restore ${failures.length} agent state snapshot(s)`);
}

function switchCommittedAgentConfig(
  app: FastifyInstance,
  config: BaxianConfig,
  affectedAgentIds: readonly string[],
  operation: 'POST' | 'PUT' | 'DELETE',
): { restartRequired: boolean; warning?: string } {
  app.ctx.config = config;
  try {
    app.ctx.agentManager.replaceConfig(config);
    app.ctx.tmuxProbePoller?.replaceConfig(config);
    app.ctx.bootstrapPoller?.replaceConfig(config);
    app.ctx.dispatchReconciler?.replaceConfig(config);
    return { restartRequired: false };
  } catch (err) {
    for (const agentId of affectedAgentIds) {
      app.ctx.agentManager.retainTombstoneForDivergence(agentId);
    }
    app.log.fatal(
      { err, agentIds: affectedAgentIds },
      `${operation} /agents in-memory config switch failed after disk commit; restart required`,
    );
    return {
      restartRequired: true,
      warning: 'in-memory config switch failed after disk commit; restart the server',
    };
  }
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', async () => {
    return redactProjects(app.ctx.config.project);
  });

  app.get<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const project = app.ctx.config.project.find(p => p.id === request.params.id);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    return redactProjects([project])[0];
  });

  app.post<{ Params: { id: string } }>('/projects/:id/bootstrap', async (request, reply) => {
    if (!app.ctx.bootstrapPoller) {
      return reply.status(503).send({ error: 'bootstrap poller not initialised' });
    }
    const result = await app.ctx.bootstrapPoller.pollProject(request.params.id);
    if (!result.knownProject) {
      return reply.status(404).send({
        error: `Project "${request.params.id}" not found in active bootstrap config (a recent PATCH /config may need a server restart to take effect)`,
      });
    }
    if (result.ran === 0) {
      return reply.send({ ok: true, ran: 0, message: 'no bootstrap targets for this project' });
    }
    return reply.send({ ok: result.ok, ran: result.ran });
  });

  app.post<{ Params: { id: string }; Body: { fix?: boolean } | null }>(
    '/projects/:id/checks',
    async (request, reply) => {
      const project = app.ctx.config.project.find(p => p.id === request.params.id);
      if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      const entries: CheckEntry[] = [];
      const checks: Promise<CheckRun>[] = [];
      const gitPlatform = app.ctx.agentManager.agentGitPreflightContext(project.id);
      for (const pair of project.agent) {
        for (const agent of pair) {
          const host = resolveAgentHost(app.ctx.config.host, agent.host);
          const runner = createRunner(agent.mode, host);
          entries.push({ agent, hostGroup: hostGroupKey(agent.mode, host), runner });
          checks.push(
            runPreflight(runner, agent, project.repo, host, project.id, gitPlatform, {
              requireGitPush: agent.role === 'dev',
            }).then(results => ({
              agentId: agent.id,
              mode: agent.mode,
              results,
            })),
          );
        }
      }
      const agents = await Promise.all(checks);
      let server: { results: PreflightResult[] } | undefined;
      if (projectNeedsPlatformEntry(app.ctx.config, project)) {
        server = { results: await runServerHostChecks(app.ctx.agentManager, project.id) };
      }
      if (request.body?.fix !== true) {
        return reply.status(201).send({ projectId: project.id, agents, ...(server ? { server } : {}) });
      }
      const fixes = await fixMissingTmux(project.id, entries, agents);
      return reply.status(201).send({ projectId: project.id, agents, ...(server ? { server } : {}), fixes });
    },
  );

  app.delete<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    if (!app.ctx.configPath) {
      return reply.status(500).send({ error: 'No config path configured' });
    }
    return withConfigLock(async () => {
      const { id } = request.params;
      const project = app.ctx.config.project.find(p => p.id === id);
      if (!project) {
        return reply.status(404).send({ error: `Project "${id}" not found` });
      }
      const remaining = project.agent.flat();
      if (remaining.length > 0) {
        return reply.status(409).send({
          error:
            `Project "${id}" still has ${remaining.length} agent(s); ` +
            `delete every agent (which reclaims its tmux session / Workdir binding) before deleting the project.`,
          agents: remaining.map(a => a.id),
        });
      }
      const next: BaxianConfig = {
        ...app.ctx.config,
        project: app.ctx.config.project.filter(p => p.id !== id),
      };

      let validated: BaxianConfig;
      try {
        validated = prepareConfig(next);
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          return reply.status(400).send({ error: 'Invalid config', details: err.errors });
        }
        throw err;
      }

      const guarded = await app.ctx.agentManager.guardGitConfigCommit(
        app.ctx.config,
        validated,
        async (manager) => {
          const active = await manager.listActiveGitTasks(id);
          return active.length > 0 ? [{ projectId: id, taskIds: active.map(t => t.id) }] : [];
        },
        async () => {
          const hotReload = await prepareConfigHotReload(app.ctx, validated);
          await saveConfig(app.ctx.configPath!, validated);
          app.ctx.config = validated;
          await applyConfigHotReload(app.ctx, validated, hotReload);
        },
      );
      if (!guarded.ok) {
        return reply.status(409).send({
          error:
            `Project "${id}" still has ${guarded.blockers[0]!.taskIds.length} active platform-bound task(s); ` +
            `wait for them to finish or cancel them before deleting the project.`,
          tasks: guarded.blockers[0]!.taskIds,
          details: gitBindingBlockerDetails(guarded.blockers),
        });
      }
      return reply.status(200).send({ removed: id, restartRequired: false });
    });
  });

  app.post<{ Body: { id?: string; repo?: string; merge?: MergeStrategy; specApproval?: SpecApprovalStrategy; gitCli?: ProjectConfig['gitCli'] } }>(
    '/projects',
    async (request, reply) => {
      if (!app.ctx.configPath) {
        return reply.status(500).send({ error: 'No config path configured' });
      }

      return withConfigLock(async () => {
        const { id, repo, merge, specApproval, gitCli } = request.body ?? {};
        if (!id || typeof id !== 'string') {
          return reply.status(400).send({ error: 'id must be a non-empty string' });
        }
        if (!repo || typeof repo !== 'string') {
          return reply.status(400).send({ error: 'repo must be a non-empty string' });
        }
        if (app.ctx.config.project.some(p => p.id === id)) {
          return reply.status(409).send({ error: `Project id "${id}" already exists` });
        }

        const newProject: ProjectConfig = {
          id,
          repo,
          merge: merge ?? null,
          ...(specApproval !== undefined ? { specApproval } : {}),
          ...(gitCli !== undefined ? { gitCli } : {}),
          agent: [],
        };

        const merged: BaxianConfig = {
          ...app.ctx.config,
          project: [...app.ctx.config.project, newProject],
        };

        let validated: BaxianConfig;
        try {
          validated = prepareConfig(merged);
        } catch (err) {
          if (err instanceof ConfigValidationError) {
            return reply.status(400).send({ error: 'Invalid config', details: err.errors });
          }
          throw err;
        }

        try {
          await app.ctx.agentManager.ensurePluginSkillPools(validated);
        } catch (err) {
          return reply.status(400).send({
            error: `git-driver plugin skill pool is unusable for this config: ${err instanceof Error ? err.message : String(err)}`,
          });
        }

        const guarded = await app.ctx.agentManager.guardGitConfigCommit(
          app.ctx.config,
          validated,
          (manager, cur, next) => gitBindingBlockers(manager, cur, next),
          async () => {
            const hotReload = await prepareConfigHotReload(app.ctx, validated);
            await saveConfig(app.ctx.configPath!, validated);
            app.ctx.config = validated;
            await applyConfigHotReload(app.ctx, validated, hotReload);
          },
        );
        if (!guarded.ok) {
          return reply.status(409).send({
            error:
              `Cannot create project "${id}": its repo is locked by ${guarded.blockers[0]!.taskIds.length} active `
              + `platform-bound task(s) in another project; wait for them to finish or cancel them first.`,
            tasks: guarded.blockers[0]!.taskIds,
            details: gitBindingBlockerDetails(guarded.blockers),
          });
        }
        const stored = validated.project.find(p => p.id === id)!;
        return reply.status(201).send({ project: stored, restartRequired: false });
      });
    },
  );

  app.post<{
    Params: { projectId: string };
    Body: { agents?: AgentConfig[] };
  }>('/projects/:projectId/agents', async (request, reply) => {
    if (!app.ctx.configPath) {
      return reply.status(500).send({ error: 'No config path configured' });
    }

    const { projectId } = request.params;
    const agents = request.body?.agents;
    if (!Array.isArray(agents) || agents.length !== 2) {
      return reply.status(400).send({ error: 'agents must contain exactly one dev and one qa agent' });
    }
    const dev = agents.find(agent => agent?.role === 'dev');
    const qa = agents.find(agent => agent?.role === 'qa');
    if (!dev || !qa || agents.some(agent => agent?.role !== 'dev' && agent?.role !== 'qa')) {
      return reply.status(400).send({ error: 'agents must contain exactly one dev and one qa agent' });
    }
    if (typeof dev.id !== 'string' || dev.id.trim() === ''
      || typeof qa.id !== 'string' || qa.id.trim() === '') {
      return reply.status(400).send({ error: 'both agent ids are required' });
    }
    if (dev.id === qa.id) {
      return reply.status(409).send({ error: `Agent id "${dev.id}" is duplicated within the group` });
    }

    const creationTokens = new Map<string, string>();
    const warnings: string[] = [];
    let restartRequired = false;

    const phase1Result = await withConfigLock(async () => {
      const project = app.ctx.config.project.find(p => p.id === projectId);
      if (!project) {
        return reply.status(404).send({ error: `Project "${projectId}" not found` });
      }

      let workdirConfig = app.ctx.config;
      for (const agentInput of [dev, qa]) {
        const existsGlobally = app.ctx.config.project.some(p =>
          p.agent.some(group => group.some(agent => agent.id === agentInput.id)),
        );
        if (existsGlobally) {
          return reply.status(409).send({ error: `Agent id "${agentInput.id}" already exists` });
        }
        if (app.ctx.agentManager.isDeletionInFlight(agentInput.id)) {
          return reply.status(409).send({
            error: `Agent id "${agentInput.id}" is being deleted (or its deletion diverged); retry later or restart the server`,
          });
        }
        const workdirConflict = findConfiguredWorkdirConflict(workdirConfig, agentInput);
        if (workdirConflict) {
          return reply.status(409).send({
            error:
              `Workdir "${normalize(agentInput.workdir!)}" is already used by agent ` +
              `"${workdirConflict}" on the same host; different agents must not share a directory`,
          });
        }
        workdirConfig = {
          ...workdirConfig,
          project: workdirConfig.project.map(p => p.id === projectId
            ? { ...p, agent: [...p.agent, [agentInput]] }
            : p),
        };
      }

      const merged: BaxianConfig = {
        ...app.ctx.config,
        project: app.ctx.config.project.map(p => p.id === projectId
          ? { ...p, agent: [...p.agent, [dev, qa]] }
          : p),
      };

      let validated: BaxianConfig;
      try {
        validated = prepareConfig(merged);
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          return reply.status(400).send({ error: 'Invalid config', details: err.errors });
        }
        throw err;
      }

      const stateSnapshots = new Map<string, AgentBindingFacts | null>();
      for (const agent of [dev, qa]) {
        stateSnapshots.set(agent.id, await app.ctx.agentStore.get(agent.id));
      }
      const now = new Date().toISOString();
      try {
        for (const agent of [dev, qa]) {
          const creationToken = randomUUID();
          await app.ctx.agentStore.set({
            id: agent.id,
            projectId,
            creationToken,
            updatedAt: now,
          });
          creationTokens.set(agent.id, creationToken);
        }
      } catch (err) {
        creationTokens.clear();
        const rollbackError = await restoreAgentStateSnapshots(app, stateSnapshots);
        if (rollbackError) {
          app.log.error(
            { err: rollbackError, agentIds: [dev.id, qa.id] },
            'POST /agents state initialization rollback failed',
          );
          return reply.status(500).send({
            error:
              `agent state initialization failed and staged state could not be restored safely: ${
                rollbackError.message
              }`,
          });
        }
        return reply.status(500).send({
          error:
            `agent state initialization failed; the group was not committed: ${
              err instanceof Error ? err.message : String(err)
            }`,
        });
      }

      try {
        await saveConfig(app.ctx.configPath!, validated);
      } catch (err) {
        creationTokens.clear();
        const rollbackError = await restoreAgentStateSnapshots(app, stateSnapshots);
        if (rollbackError) {
          app.log.error(
            { err: rollbackError, agentIds: [dev.id, qa.id] },
            'POST /agents config save state rollback failed',
          );
          return reply.status(500).send({
            error: `config save failed and staged agent state could not be restored safely: ${rollbackError.message}`,
          });
        }
        return reply.status(500).send({
          error:
            `failed to persist agent group config; staged agent state was restored: ${
              err instanceof Error ? err.message : String(err)
            }`,
        });
      }
      const switchResult = switchCommittedAgentConfig(
        app,
        validated,
        [dev.id, qa.id],
        'POST',
      );
      restartRequired = switchResult.restartRequired;
      if (switchResult.warning) {
        creationTokens.clear();
        warnings.push(switchResult.warning);
        return null;
      }
      return null;
    });
    if (phase1Result) return phase1Result;
    if (reply.sent) return reply;

    for (const [agentId, creationToken] of creationTokens) {
      void app.ctx.agentManager.startBootstrapAsync(agentId, creationToken).catch((err) => {
        app.log.error(
          { err, agentId },
          'POST /agents startBootstrapAsync threw — should be impossible',
        );
      });
    }

    const storedProject = app.ctx.config.project.find(p => p.id === projectId)!;
    const storedGroup = storedProject.agent.find(group => group.some(agent => agent.id === dev.id))!;
    return reply.status(201).send({
      agents: storedGroup,
      runtimeStatus: 'pending',
      restartRequired,
      ...(warnings.length ? { warnings } : {}),
    });
  });

  app.put<{
    Params: { projectId: string; agentId: string };
    Body: AgentConfig;
  }>('/projects/:projectId/agents/:agentId', async (request, reply) => {
    if (!app.ctx.configPath) {
      return reply.status(500).send({ error: 'No config path configured' });
    }
    const { projectId, agentId } = request.params;
    const replacement = request.body;
    if (!replacement || (replacement.role !== 'dev' && replacement.role !== 'qa')) {
      return reply.status(400).send({ error: 'replacement role must be "dev" or "qa"' });
    }
    if (typeof replacement.id !== 'string' || replacement.id.trim() === '') {
      return reply.status(400).send({ error: 'replacement agent id is required' });
    }
    if (replacement.id === agentId) {
      return reply.status(400).send({ error: 'replacement agent id must differ from the current agent id' });
    }

    let bootstrap: { agentId: string; creationToken: string } | null = null;
    let replacementResult: {
      agent: AgentConfig;
      replaced: string;
      runtimeStatus: 'pending';
      restartRequired: boolean;
      warnings?: string[];
    } | null = null;
    const phaseResult = await withConfigLock(async () => {
      const project = app.ctx.config.project.find(p => p.id === projectId);
      if (!project) {
        return reply.status(404).send({ error: `Project "${projectId}" not found` });
      }
      const group = project.agent.find(candidate => candidate.some(agent => agent.id === agentId));
      const current = group?.find(agent => agent.id === agentId);
      if (!group || !current) {
        return reply.status(404).send({ error: `Agent "${agentId}" not found in project "${projectId}"` });
      }
      if (replacement.role !== current.role) {
        return reply.status(400).send({
          error: `replacement role must remain "${current.role}" so the group keeps one dev and one qa`,
        });
      }
      const existsGlobally = app.ctx.config.project.some(p =>
        p.agent.some(candidate => candidate.some(agent => agent.id === replacement.id)),
      );
      if (existsGlobally) {
        return reply.status(409).send({ error: `Agent id "${replacement.id}" already exists` });
      }
      if (app.ctx.agentManager.isDeletionInFlight(replacement.id)) {
        return reply.status(409).send({
          error: `Agent id "${replacement.id}" is being deleted (or its deletion diverged); retry later or restart the server`,
        });
      }
      const workdirConflict = findConfiguredWorkdirConflict(
        app.ctx.config,
        replacement,
        new Set([agentId]),
      );
      if (workdirConflict) {
        return reply.status(409).send({
          error:
            `Workdir "${normalize(replacement.workdir!)}" is already used by agent ` +
            `"${workdirConflict}" on the same host; different agents must not share a directory`,
        });
      }

      const nextConfig: BaxianConfig = {
        ...app.ctx.config,
        project: app.ctx.config.project.map(p => p.id === projectId
          ? {
              ...p,
              agent: p.agent.map(candidate => candidate.some(agent => agent.id === agentId)
                ? candidate.map(agent => agent.id === agentId ? replacement : agent)
                : candidate),
            }
          : p),
      };
      let validated: BaxianConfig;
      try {
        validated = prepareConfig(nextConfig);
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          return reply.status(400).send({ error: 'Invalid config', details: err.errors });
        }
        throw err;
      }
      const storedReplacement = validated.project
        .find(candidate => candidate.id === projectId)!
        .agent.flat()
        .find(agent => agent.id === replacement.id)!;

      const removal = new AgentRemovalTransaction(app, [agentId], 'PUT');
      try {
        const deletion = await removal.claim();
        if (!deletion.ok) {
          switch (deletion.code) {
            case 'active':
              return reply.status(409).send({
                error: `Agent "${deletion.agentId}" is still active on task ${deletion.taskId}; finish or cancel it before replacement.`,
              });
            case 'bootstrapping':
              return reply.status(409).send({
                error: `Agent "${deletion.agentId}" is bootstrapping; retry after bootstrap settles.`,
              });
            case 'referencing':
              return reply.status(409).send({
                error: `Agent "${agentId}" is referenced by open task ${deletion.taskId}; finish or cancel it before replacement.`,
              });
            case 'already-deleting':
              return reply.status(409).send({
                error: `Agent "${deletion.agentId}" deletion or replacement is already in progress.`,
              });
          }
        }

        const rotation = await removal.rotateClaims();
        if (!rotation.ok) {
          switch (rotation.code) {
            case 'locked':
            case 'stale-binding':
              return reply.status(409).send({
                error: `Agent "${rotation.agentId}" is locked by another operation; retry replacement later.`,
              });
            case 'claim-changed':
              return reply.status(409).send({
                error: `Agent "${rotation.agentId}" lock changed; retry replacement.`,
              });
          }
        }

        try {
          await app.ctx.agentManager.cleanupRemovedAgentRuntime([agentId]);
        } catch (err) {
          const rollbackError = await removal.rollbackStateAndClaims();
          if (rollbackError) {
            app.log.error({ err: rollbackError, agentId }, 'PUT /agents replacement rollback failed');
            return reply.status(500).send({
              error: `runtime cleanup failed and the original agent state could not be restored safely: ${
                rollbackError.message
              }`,
            });
          }
          return reply.status(502).send({
            error: `runtime cleanup failed for ${agentId}; the original config, state, and lock were restored`,
            detail: err instanceof Error ? err.message : String(err),
          });
        }

        try {
          await saveConfig(app.ctx.configPath!, validated);
        } catch (err) {
          const rollbackError = await removal.rollbackStateAndClaims();
          if (rollbackError) {
            app.log.error({ err: rollbackError, agentId }, 'PUT /agents save rollback failed');
            return reply.status(500).send({
              error: `config save failed and the original agent state could not be restored safely: ${rollbackError.message}`,
            });
          }
          return reply.status(500).send({
            error: `failed to persist replacement config; the original agent state and lock were restored: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
        const commitResult = await removal.finalizeCommit(validated, {
          divergenceTargets: [agentId, replacement.id],
          beforeConfigSwitch: async (warnings) => {
            const creationToken = randomUUID();
            try {
              await app.ctx.agentStore.set({
                id: replacement.id,
                projectId,
                creationToken,
                updatedAt: new Date().toISOString(),
              });
              bootstrap = { agentId: replacement.id, creationToken };
            } catch (err) {
              const warning = `replacement agent ${replacement.id} state initialization failed: ${err instanceof Error ? err.message : String(err)}`;
              warnings.push(warning);
              app.log.error({ err, agentId: replacement.id }, `PUT /agents ${warning}`);
            }
          },
        });
        if (commitResult.restartRequired) bootstrap = null;

        replacementResult = {
          agent: storedReplacement,
          replaced: agentId,
          runtimeStatus: 'pending',
          restartRequired: commitResult.restartRequired,
          ...(commitResult.warnings.length ? { warnings: commitResult.warnings } : {}),
        };
        return null;
      } finally {
        await removal.finish().catch((err) => {
          app.log.error({ err, agentId }, 'PUT /agents leftover replacement cleanup failed');
        });
      }
    });
    if (phaseResult) return phaseResult;
    if (reply.sent) return reply;

    if (bootstrap) {
      const { agentId: replacementId, creationToken } = bootstrap;
      void app.ctx.agentManager.startBootstrapAsync(replacementId, creationToken).catch((err) => {
        app.log.error(
          { err, agentId: replacementId },
          'PUT /agents startBootstrapAsync threw — should be impossible',
        );
      });
    }
    return reply.send(replacementResult!);
  });

  app.delete<{ Params: { projectId: string; agentId: string } }>(
    '/projects/:projectId/agents/:agentId',
    async (request, reply) => {
      if (!app.ctx.configPath) {
        return reply.status(500).send({ error: 'No config path configured' });
      }
      const { projectId, agentId } = request.params;

      let targets: string[] = [];
      let originalConfigHash = '';
      let validatedAfterRemove: BaxianConfig | null = null;
      const removalRef: { current: AgentRemovalTransaction | null } = { current: null };

      try {
        const phase1Result = await withConfigLock(async () => {
          const project = app.ctx.config.project.find(p => p.id === projectId);
          if (!project) {
            return reply.status(404).send({ error: `Project "${projectId}" not found` });
          }

          const found = project.agent.flat().find(a => a.id === agentId);
          if (!found) {
            return reply.status(404).send({ error: `Agent "${agentId}" not found in project "${projectId}"` });
          }
          targets = app.ctx.agentManager.prepareRemoveTargets(agentId).targets.slice().sort();
          const transaction = new AgentRemovalTransaction(app, targets, 'DELETE');
          removalRef.current = transaction;

          const claim = await transaction.claim();
          if (!claim.ok) {
            switch (claim.code) {
              case 'active':
                return reply.status(409).send({
                  error:
                    `Agent "${claim.agentId}" is still active on task ${claim.taskId}; cancel the task before deleting ` +
                    `(prevents orphan task / tmux session / lock / Workdir binding).`,
                });
              case 'bootstrapping':
                return reply.status(409).send({
                  error:
                    `Agent "${claim.agentId}" is bootstrapping; retry shortly or wait for it to enter awaiting_human state.`,
                });
              case 'referencing':
                return reply.status(409).send({
                  error:
                    `Agent "${agentId}" is referenced by open task ${claim.taskId}; ` +
                    `cancel or finish that task before deleting (would dangle its dev/QA/retry reference).`,
                });
              case 'already-deleting':
                return reply.status(409).send({
                  error: `Agent "${claim.agentId}" deletion already in progress; please wait and retry`,
                });
            }
          }

          const rotation = await transaction.rotateClaims();
          if (!rotation.ok) {
            switch (rotation.code) {
              case 'locked':
                return reply.status(409).send({
                  error: `Agent "${rotation.agentId}" is currently locked by another op; please retry later`,
                });
              case 'stale-binding':
                return reply.status(409).send({
                  error:
                    `Agent "${rotation.agentId}" has a stale task binding whose exclusive lock is owned by another ` +
                    `operation; retry after it finishes.`,
                });
              case 'claim-changed':
                return reply.status(409).send({
                  error: `Agent "${rotation.agentId}" lock changed while claiming it for deletion; please retry.`,
                });
            }
          }

          originalConfigHash = configHash(app.ctx.config);
          const removeRequest = omitAgentsFromProject(app.ctx.config, projectId, targets);
          try {
            validatedAfterRemove = prepareConfig(removeRequest);
          } catch (err) {
            const rollbackError = await transaction.rollbackClaimsForRetry();
            if (rollbackError) throw rollbackError;
            if (err instanceof ConfigValidationError) {
              return reply.status(400).send({ error: 'Invalid config', details: err.errors });
            }
            throw err;
          }
          return null;
        });
        if (phase1Result) return phase1Result;
        if (reply.sent) return reply;

        try {
          await app.ctx.agentManager.cleanupRemovedAgentRuntime(targets);
        } catch (err) {
          const failures = err instanceof CleanupFailedError
            ? err.failures
            : [{ agentId, step: 'runtime.cleanup', error: err }];
          app.log.error(
            { failures, targets },
            'DELETE /agents cleanupRemovedAgentRuntime failed; rolling back state and locks',
          );
          const rollbackError = await withConfigLock(
            () => removalRef.current!.rollbackStateAndClaims(),
          );
          if (rollbackError) {
            app.log.error({ err: rollbackError, targets }, 'DELETE /agents rollback failed');
            return reply.status(500).send({
              error: `runtime cleanup failed and agent state could not be restored safely: ${rollbackError.message}`,
            });
          }
          return reply.status(502).send({
            error:
              `runtime cleanup failed for ${targets.join(',')}; agent state and exact task locks were restored. ` +
              `Fix the underlying SSH / tmux / Workdir issue and retry DELETE.`,
            failures: failures.map(f => ({
              agentId: f.agentId,
              step: f.step,
              error: f.error instanceof Error ? f.error.message : String(f.error),
            })),
          });
        }

        const transaction = removalRef.current!;
        const phase3Result = await withConfigLock(async () => {
          const currentHash = configHash(app.ctx.config);
          const rollbackBase = currentHash === originalConfigHash
            ? validatedAfterRemove!
            : omitAgentsFromProject(app.ctx.config, projectId, targets);
          let validated: BaxianConfig;
          try {
            validated = prepareConfig(rollbackBase);
          } catch (err) {
            const rollbackError = await transaction.rollbackStateAndClaims();
            if (rollbackError) {
              app.log.error({ err: rollbackError, targets }, 'DELETE /agents rollback after config validation failed');
              return reply.status(500).send({
                error: `config validation and agent-state rollback both failed: ${rollbackError.message}`,
              });
            }
            if (err instanceof ConfigValidationError) {
              return reply.status(400).send({ error: 'Invalid config', details: err.errors });
            }
            throw err;
          }

          try {
            await saveConfig(app.ctx.configPath!, validated);
          } catch (err) {
            app.log.error(
              { err, targets },
              'DELETE /agents Phase 3 saveConfig failed; releasing acquired locks (no state was deleted yet)',
            );
            const rollbackError = await transaction.rollbackClaimsForRetry();
            if (rollbackError) {
              return reply.status(500).send({
                error: `failed to persist config and roll the deletion locks back safely: ${rollbackError.message}`,
              });
            }
            return reply.status(500).send({
              error: 'failed to persist config after runtime cleanup; this attempt\'s locks were released and agent state left intact',
            });
          }
          const commitResult = await transaction.finalizeCommit(validated);

          return reply.send({
            removed: targets,
            restartRequired: commitResult.restartRequired,
            ...(commitResult.warnings.length ? { warnings: commitResult.warnings } : {}),
          });
        });
        return phase3Result;
      } finally {
        if (removalRef.current) {
          await removalRef.current.finish().catch((err: unknown) => {
            app.log.error({ err }, 'DELETE /agents leftover deletion-claim cleanup failed');
          });
        }
      }
    },
  );

  app.post<{ Params: { projectId: string; agentId: string } }>(
    '/projects/:projectId/agents/:agentId/resume',
    async (request, reply) => {
      const { projectId, agentId } = request.params;
      const cfg = app.ctx.agentManager.getAgentConfig(agentId);
      if (!cfg || cfg.projectId !== projectId) {
        return reply.status(404).send({ error: `Agent "${agentId}" not found in project "${projectId}"` });
      }
      return withConfigLock(async () => {
        if (app.ctx.agentManager.isDeletionInFlight(agentId)) {
          return reply.status(409).send({
            error: `Agent "${agentId}" is being deleted; Resume not allowed.`,
          });
        }
        const state = await app.ctx.agentStore.get(agentId);
        if (state?.status !== 'awaiting_human') {
          return reply.status(409).send({
            error: `Agent "${agentId}" is not awaiting human; nothing to resume.`,
          });
        }
        const result = await app.ctx.agentManager.resumeAgent(agentId);
        if (!result.resumed) {
          const refreshed = await app.ctx.agentStore.get(agentId);
          const reason = refreshed?.creationToken
            ? 'Bootstrap dialog still unresolved; resolve via web terminal or DELETE the agent.'
            : result.reason ?? 'Resume rejected; agent not in a state that can be resumed.';
          return reply.status(409).send({ error: reason, ...result, agentId });
        }
        return reply.send({ agentId, ...result });
      });
    },
  );

  app.post<{ Params: { projectId: string; agentId: string } }>(
    '/projects/:projectId/agents/:agentId/restart-repl',
    async (request, reply) => {
      const { projectId, agentId } = request.params;
      const cfg = app.ctx.agentManager.getAgentConfig(agentId);
      if (!cfg || cfg.projectId !== projectId) {
        return reply.status(404).send({ error: `Agent "${agentId}" not found in project "${projectId}"` });
      }
      const guard = await rejectIfOpInProgress(app, agentId);
      if (guard) return reply.status(guard.status).send({ error: guard.error });
      if (app.ctx.agentManager.isDeletionInFlight(agentId)) {
        return reply.status(409).send({ error: `Agent "${agentId}" is being deleted; restart-repl not allowed.` });
      }
      const genAtEntry = app.ctx.agentManager.deletionGenerationOf(agentId);

      const owner = await resolveLockOwnership(app, agentId);
      const maintenanceOwner = 'maintenance:restart-repl';
      let maintenanceLockOwner = maintenanceOwner;
      let maintenanceToken: string | null = null;
      let acquiredMaintenanceLock = false;
      if (!owner.takeover) {
        const stateBefore = await app.ctx.agentStore.get(agentId);
        const task = stateBefore?.taskId ? await app.ctx.taskStore.get(stateBefore.taskId) : null;
        if (task && TASK_ACTIVE_STATUS_SET.has(task.status)) {
          return reply.status(409).send({
            error:
              `agent "${agentId}" is bound to active task ${task.id}; ` +
              `restart-repl is reserved for failed REPLs — interrupting a healthy ` +
              `task would lose work. cancel the task first.`,
          });
        }
        maintenanceLockOwner = stateBefore?.taskId ?? maintenanceOwner;
        const lock = await acquireOrReuseExactLock(app, agentId, maintenanceLockOwner);
        if (!lock) {
          return reply.status(409).send({ error: `Agent "${agentId}" is locked by another op; please retry later` });
        }
        maintenanceToken = lock.token;
        acquiredMaintenanceLock = lock.acquired;
      }

      try {
        await app.ctx.agentManager.restartReplOnly(agentId, { expectedGeneration: genAtEntry });
      } catch (err) {
        if (maintenanceToken && acquiredMaintenanceLock) {
          await app.ctx.lockManager.releaseIfOwner(agentId, maintenanceLockOwner, maintenanceToken);
        }
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
      await pendingCleanupAfterReplReady(app, agentId, owner.takeover, maintenanceToken
        ? { taskId: maintenanceLockOwner, token: maintenanceToken }
        : undefined);
      return reply.send({ ok: true, agentId });
    },
  );

  app.post<{ Params: { projectId: string; agentId: string } }>(
    '/projects/:projectId/agents/:agentId/retry',
    async (request, reply) => {
      const { projectId, agentId } = request.params;
      const cfg = app.ctx.agentManager.getAgentConfig(agentId);
      if (!cfg || cfg.projectId !== projectId) {
        return reply.status(404).send({ error: `Agent "${agentId}" not found in project "${projectId}"` });
      }
      if (app.ctx.agentManager.isDeletionInFlight(agentId)) {
        return reply.status(409).send({ error: `Agent "${agentId}" is being deleted; retry not allowed.` });
      }
      const genAtEntry = app.ctx.agentManager.deletionGenerationOf(agentId);
      const stateBefore = await app.ctx.agentStore.get(agentId);
      if (stateBefore?.creationToken) {
        return reply.status(409).send({
          error: 'agent is being created, please retry later',
        });
      }
      if (app.ctx.tmuxSessionStatusStore.get(agentId).tmuxSessionStatus === 'present') {
        return reply.status(409).send({ error: 'agent is already ready; retry is for failed/missing sessions' });
      }

      const owner = await resolveLockOwnership(app, agentId);
      const maintenanceOwner = 'maintenance:retry';
      const maintenanceLockOwner = stateBefore?.taskId ?? maintenanceOwner;
      let maintenanceToken: string | null = null;
      let acquiredMaintenanceLock = false;
      if (!owner.takeover) {
        const task = stateBefore?.taskId ? await app.ctx.taskStore.get(stateBefore.taskId) : null;
        if (task && TASK_ACTIVE_STATUS_SET.has(task.status)) {
          return reply.status(409).send({
            error:
              `agent "${agentId}" is bound to active task ${task.id}, but does not hold that task's ` +
              `exclusive lock; Resume or cancel the task before retrying the REPL.`,
          });
        }
        const lock = await acquireOrReuseExactLock(app, agentId, maintenanceLockOwner);
        if (!lock) {
          return reply.status(409).send({ error: `Agent "${agentId}" is locked by another op; please retry later` });
        }
        maintenanceToken = lock.token;
        acquiredMaintenanceLock = lock.acquired;
      }

      try {
        const result = await app.ctx.agentManager.ensureSession(agentId, 'runtime', { expectedGeneration: genAtEntry });
        const now = new Date().toISOString();
        const paneCommit = await app.ctx.agentStore.update(agentId, (existing) => {
          if (!existing
              || app.ctx.agentManager.isDeletionInFlight(agentId)
              || app.ctx.agentManager.deletionGenerationOf(agentId) !== genAtEntry) {
            return AGENT_STORE_NOOP;
          }
          return { ...existing, paneId: result.paneId, updatedAt: now };
        });
        if (paneCommit !== 'committed') {
          if (maintenanceToken && acquiredMaintenanceLock) {
            await app.ctx.lockManager.releaseIfOwner(agentId, maintenanceLockOwner, maintenanceToken);
          }
          return reply.status(409).send({
            error: `Agent "${agentId}" was deleted or recreated during retry; re-run retry against the current agent`,
          });
        }
      } catch (err) {
        if (await app.ctx.agentManager.handleDialogPendingFromRuntime(agentId, err, { expectedGeneration: genAtEntry })) {
          if (maintenanceToken && acquiredMaintenanceLock) {
            await app.ctx.lockManager.releaseIfOwner(agentId, maintenanceLockOwner, maintenanceToken);
          }
          return reply.status(202).send({
            ok: true,
            agentId,
            runtimeStatus: 'pending',
            message:
              'REPL launched but blocked on a startup dialog; open the web ' +
              'terminal to dismiss — baxian will auto-detect ready and resume',
          });
        }
        await app.ctx.agentManager.rollbackEnsureSessionFailure(agentId, err, 'POST /retry ensure rollback');
        if (maintenanceToken && acquiredMaintenanceLock) {
          await app.ctx.lockManager.releaseIfOwner(agentId, maintenanceLockOwner, maintenanceToken);
        }
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
      await pendingCleanupAfterReplReady(app, agentId, owner.takeover, maintenanceToken
        ? { taskId: maintenanceLockOwner, token: maintenanceToken }
        : undefined);
      return reply.send({ ok: true, agentId });
    },
  );
}

function findConfiguredWorkdirConflict(
  config: BaxianConfig,
  candidate: AgentConfig,
  ignoredAgentIds: ReadonlySet<string> = new Set(),
): string | null {
  if (
    typeof candidate.workdir !== 'string'
    || candidate.workdir.trim() === ''
    || !isAbsolute(candidate.workdir)
    || (candidate.mode !== 'local' && candidate.mode !== 'remote')
  ) return null;
  const resolvedCandidateHost = resolveAgentHost(config.host, candidate.host);
  if (
    candidate.mode === 'remote'
    && (!resolvedCandidateHost || typeof resolvedCandidateHost.hostname !== 'string')
  ) return null;
  const candidatePath = normalize(candidate.workdir);
  const configured: Array<{
    id: string;
    mode: AgentMode;
    host: ReturnType<typeof resolveAgentHost>;
    workdir: string;
  }> = [];
  for (const project of config.project) {
    for (const existing of project.agent.flat()) {
      if (!existing.workdir) continue;
      configured.push({
        id: existing.id,
        mode: existing.mode,
        host: resolveAgentHost(config.host, existing.host),
        workdir: existing.workdir,
      });
    }
  }
  for (const existing of configured) {
    if (ignoredAgentIds.has(existing.id)) continue;
    if (
      normalize(existing.workdir) === candidatePath
      && mayShareHostAccount(
        existing.mode,
        existing.host,
        candidate.mode,
        resolvedCandidateHost,
      )
    ) {
      return existing.id;
    }
  }
  return null;
}

interface LockOwner {
  takeover: boolean;
}

async function acquireOrReuseExactLock(
  app: FastifyInstance,
  agentId: string,
  taskId: string,
): Promise<{ token: string; acquired: boolean } | null> {
  const claim = await app.ctx.lockManager.claimOf(agentId);
  if (claim) {
    return claim.taskId === taskId ? { token: claim.token, acquired: false } : null;
  }
  const token = await app.ctx.lockManager.acquire(agentId, taskId);
  return token ? { token, acquired: true } : null;
}

async function resolveLockOwnership(
  app: FastifyInstance,
  agentId: string,
): Promise<LockOwner> {
  const cfg = app.ctx.agentManager.getAgentConfig(agentId);
  if (!cfg || !TASK_OWNER_ROLES.has(cfg.role)) return { takeover: false };
  const state = await app.ctx.agentStore.get(agentId);
  if (!state?.taskId) return { takeover: false };
  const task = await app.ctx.taskStore.get(state.taskId);
  if (!task) return { takeover: false };
  if (!TASK_ACTIVE_STATUS_SET.has(task.status)) return { takeover: false };
  let token = state.lockToken;
  if (!token || !(await app.ctx.lockManager.isOwner(agentId, task.id, token))) {
    const claim = await app.ctx.lockManager.claimOf(agentId);
    token = claim?.taskId === task.id ? claim.token : undefined;
    if (token) {
      await app.ctx.agentStore.update(agentId, (latest) => {
        if (!latest || latest.taskId !== task.id || latest.lockToken === token) return latest;
        return { ...latest, lockToken: token, updatedAt: new Date().toISOString() };
      });
    }
  }
  if (!token) return { takeover: false };
  return { takeover: await app.ctx.lockManager.isOwner(agentId, task.id, token) };
}

async function rejectIfOpInProgress(
  app: FastifyInstance,
  agentId: string,
): Promise<{ status: number; error: string } | null> {
  const state = await app.ctx.agentStore.get(agentId);
  if (state?.creationToken) {
    return { status: 409, error: `agent "${agentId}" is being created; please retry later` };
  }
  return null;
}

async function pendingCleanupAfterReplReady(
  app: FastifyInstance,
  agentId: string,
  takeover: boolean,
  maintenance?: { taskId: string; token: string },
): Promise<void> {
  const state = await app.ctx.agentStore.get(agentId);
  const taskId = state?.taskId;
  if (!taskId) {
    if (state?.awaitingPhase === 'greeting_failed') {
      await app.ctx.agentManager.regreetHeldAgent(agentId);
    } else {
      await app.ctx.agentManager.clearAwaitingHuman(agentId);
    }
    if (!takeover && maintenance) {
      await app.ctx.lockManager.releaseIfOwner(agentId, maintenance.taskId, maintenance.token);
    }
    return;
  }
  const task = await app.ctx.taskStore.get(taskId);
  if (!task || TASK_TERMINAL_STATUS_SET.has(task.status)) {
    if (maintenance?.taskId === taskId) {
      await app.ctx.agentStore.update(agentId, (latest) => {
        if (!latest || latest.taskId !== taskId) return latest;
        return {
          ...latest,
          lockToken: maintenance.token,
          updatedAt: new Date().toISOString(),
        };
      });
    }
    await app.ctx.agentManager.releaseAgentForTask(agentId, taskId, 'idle', { allowAwaitingHuman: true })
      .catch(err => app.log.warn({ err, agentId, taskId }, 'restart/retry idle-release failed'));
    return;
  }
  if (takeover) {
    try {
      if (await app.ctx.agentManager.redispatchTaskPromptAfterReplRestart(agentId, taskId)) return;
    } catch (err) {
      app.log.error({ err, agentId, taskId }, 'restart/retry task prompt redispatch failed');
      const held = await app.ctx.agentManager.holdReplayFailureIfCurrent(
        agentId,
        task,
        'restart-redispatch-failed',
        `REPL restarted but the active task prompt could not be restored: ${err instanceof Error ? err.message : String(err)}`,
        {
          phase: state?.status === 'awaiting_human' ? state.awaitingPhase : undefined,
          since: state?.status === 'awaiting_human' ? state.awaitingSince : undefined,
          nonce: state?.status === 'awaiting_human' ? state.awaitingNonce : undefined,
        },
      );
      if (!held) {
        app.log.warn({ agentId, taskId }, 'restart/retry failure hold skipped: the pass moved past the pre-restart generation');
      }
      return;
    }
  }
  await app.ctx.agentManager.markAgentWaiting(agentId, taskId, {
    allowAwaitingHuman: true,
    clearAwaitingHuman: true,
    expectedTask: task,
    expectedHold: {
      phase: state?.status === 'awaiting_human' ? state.awaitingPhase : undefined,
      since: state?.status === 'awaiting_human' ? state.awaitingSince : undefined,
      nonce: state?.status === 'awaiting_human' ? state.awaitingNonce : undefined,
    },
  });
}
