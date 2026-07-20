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
import { TASK_ACTIVE_STATUS_SET, TASK_OWNER_ROLES, TASK_TERMINAL_STATUS_SET } from '../shared/index.js';
import { probeTmux, runPreflight, type PreflightResult } from '../agent/preflight.js';
import { installTmux } from '../agent/tmux-install.js';
import {
  createRunner,
  hostGroupKey,
  resolveAgentHost,
  workdirHostGroupKey,
  type CommandRunner,
} from '../agent/runner.js';
import { saveConfig, prepareConfig, ConfigValidationError } from '../config/loader.js';
import { withConfigLock } from '../config/mutex.js';
import { redactProjects } from './config.js';
import { CleanupFailedError } from '../agent/manager.js';
import { AGENT_STORE_NOOP } from '../state/agent-store.js';
import { applyConfigHotReload } from '../config/hot-reload.js';

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
      for (const pair of project.agent) {
        for (const agent of pair) {
          const host = resolveAgentHost(app.ctx.config.host, agent.host);
          const runner = createRunner(agent.mode, host);
          entries.push({ agent, hostGroup: hostGroupKey(agent.mode, host), runner });
          checks.push(
            runPreflight(runner, agent, project.repo, host, project.id).then(results => ({
              agentId: agent.id,
              mode: agent.mode,
              results,
            })),
          );
        }
      }
      const agents = await Promise.all(checks);
      if (request.body?.fix !== true) {
        return reply.status(201).send({ projectId: project.id, agents });
      }
      const fixes = await fixMissingTmux(project.id, entries, agents);
      return reply.status(201).send({ projectId: project.id, agents, fixes });
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

      // 扫描与删除提交经 manager 任务锁同栅栏：并发 createTask 不能在检查后为该项目落新 git 任务
      const guarded = await app.ctx.agentManager.guardGitConfigCommit(
        app.ctx.config,
        validated,
        async (manager) => {
          const active = await manager.listActiveGitTasks(id);
          return active.length > 0 ? [{ projectId: id, taskIds: active.map(t => t.id) }] : [];
        },
        async () => {
          await saveConfig(app.ctx.configPath!, validated);
          app.ctx.config = validated;
          applyConfigHotReload(app.ctx, validated);
        },
      );
      if (!guarded.ok) {
        return reply.status(409).send({
          error:
            `Project "${id}" still has ${guarded.blockers[0]!.taskIds.length} active git-mode task(s); ` +
            `wait for them to finish or cancel them before deleting the project.`,
          tasks: guarded.blockers[0]!.taskIds,
        });
      }
      return reply.status(200).send({ removed: id, restartRequired: false });
    });
  });

  app.post<{ Body: { id?: string; repo?: string; merge?: MergeStrategy; specApproval?: SpecApprovalStrategy; review?: ProjectConfig['review'] } }>(
    '/projects',
    async (request, reply) => {
      if (!app.ctx.configPath) {
        return reply.status(500).send({ error: 'No config path configured' });
      }

      return withConfigLock(async () => {
        const { id, repo, merge, specApproval, review } = request.body ?? {};
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
          ...(review !== undefined ? { review } : {}),
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

        await saveConfig(app.ctx.configPath!, validated);
        app.ctx.config = validated;
        applyConfigHotReload(app.ctx, validated);
        const stored = validated.project.find(p => p.id === id)!;
        return reply.status(201).send({ project: stored, restartRequired: false });
      });
    },
  );

  app.post<{
    Params: { projectId: string };
    Body: AgentConfig & { pairWith?: string };
  }>('/projects/:projectId/agents', async (request, reply) => {
    if (!app.ctx.configPath) {
      return reply.status(500).send({ error: 'No config path configured' });
    }

    const { projectId } = request.params;
    const body = request.body ?? ({} as AgentConfig & { pairWith?: string });
    const { pairWith, ...agentInput } = body;

    if (agentInput.role !== 'dev' && agentInput.role !== 'qa' && agentInput.role !== 'research') {
      return reply.status(400).send({ error: 'role must be "dev", "qa", or "research"' });
    }
    if (typeof agentInput.id !== 'string' || agentInput.id.trim().length === 0) {
      return reply.status(400).send({ error: 'agent id is required' });
    }

    let creationToken = '';

    const phase1Result = await withConfigLock(async () => {
      const project = app.ctx.config.project.find(p => p.id === projectId);
      if (!project) {
        return reply.status(404).send({ error: `Project "${projectId}" not found` });
      }

      const existsGlobally = app.ctx.config.project.some(p =>
        p.agent.some(pair => pair.some(a => a.id === agentInput.id)),
      );
      if (existsGlobally) {
        return reply.status(409).send({ error: `Agent id "${agentInput.id}" already exists` });
      }
      // A tombstone in flight (or retained after a DELETE memory-switch divergence) must block a
      // same-id rebuild, else the fail-stop could be silently bypassed.
      if (app.ctx.agentManager.isDeletionInFlight(agentInput.id)) {
        return reply.status(409).send({
          error: `Agent id "${agentInput.id}" is being deleted (or its deletion diverged); retry later or restart the server`,
        });
      }
      const workdirConflict = findConfiguredWorkdirConflict(app.ctx.config, agentInput);
      if (workdirConflict) {
        return reply.status(409).send({
          error:
            `Workdir "${normalize(agentInput.workdir!)}" is already used by agent ` +
            `"${workdirConflict}" on the same host; different agents must not share a directory`,
        });
      }

      if (agentInput.role !== 'dev') {
        if (!pairWith) {
          return reply.status(400).send({ error: `pairWith required when role=${agentInput.role}` });
        }
        const targetGroup = project.agent.find(
          group => group.some(agent => agent.id === pairWith && agent.role === 'dev')
            && !group.some(agent => agent.role === agentInput.role),
        );
        if (!targetGroup) {
          return reply.status(400).send({
            error: `pairWith "${pairWith}" must reference a dev group in this project that has no ${agentInput.role} yet`,
          });
        }
        const devState = await app.ctx.agentStore.get(pairWith);
        if (devState?.creationToken) {
          return reply.status(409).send({
            error: `dev agent "${pairWith}" is being created; please retry later`,
          });
        }
      }
      if (agentInput.role === 'dev' && pairWith) {
        return reply.status(400).send({ error: 'pairWith is only valid for qa or research agents' });
      }

      const newProjects = app.ctx.config.project.map((p) => {
        if (p.id !== projectId) return p;
        if (agentInput.role === 'dev') {
          return { ...p, agent: [...p.agent, [agentInput as AgentConfig]] };
        }
        const newAgent = p.agent.map(group => {
          if (group.some(agent => agent.id === pairWith && agent.role === 'dev')) {
            return [...group, agentInput as AgentConfig];
          }
          return group;
        });
        return { ...p, agent: newAgent };
      });

      const merged: BaxianConfig = { ...app.ctx.config, project: newProjects };

      let validated: BaxianConfig;
      try {
        validated = prepareConfig(merged);
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          return reply.status(400).send({ error: 'Invalid config', details: err.errors });
        }
        throw err;
      }

      await saveConfig(app.ctx.configPath!, validated);
      app.ctx.config = validated;
      app.ctx.agentManager.replaceConfig(validated);
      app.ctx.tmuxProbePoller?.replaceConfig(validated);
      app.ctx.bootstrapPoller?.replaceConfig(validated);
      app.ctx.dispatchReconciler?.replaceConfig(validated);

      creationToken = randomUUID();
      const now = new Date().toISOString();
      await app.ctx.agentStore.set({
        id: agentInput.id,
        projectId,
        creationToken,
        updatedAt: now,
      });
      return null;
    });
    if (phase1Result) return phase1Result;
    if (reply.sent) return reply;

    void app.ctx.agentManager
      .startBootstrapAsync(agentInput.id, creationToken)
      .catch((err) => {
        app.log.error(
          { err, agentId: agentInput.id },
          'POST /agents startBootstrapAsync threw — should be impossible (it never throws)',
        );
      });

    const storedProject = app.ctx.config.project.find(p => p.id === projectId)!;
    const storedAgent = storedProject.agent.flat().find(a => a.id === agentInput.id)!;
    return reply.status(201).send({
      agent: storedAgent,
      runtimeStatus: 'pending',
      restartRequired: false,
    });
  });

  app.delete<{ Params: { projectId: string; agentId: string } }>(
    '/projects/:projectId/agents/:agentId',
    async (request, reply) => {
      if (!app.ctx.configPath) {
        return reply.status(500).send({ error: 'No config path configured' });
      }
      const { projectId, agentId } = request.params;

      let targets: string[] = [];
      const originalStates: Map<string, AgentBindingFacts | null> = new Map();
      let originalConfigHash = '';
      let validatedAfterRemove: BaxianConfig | null = null;
      // Per-attempt deletion owner: phase 1 rotates every claim onto it (so a concurrent maintenance release with the old shared token fails owner-scoped); phase 3 releases it, rollback rotates back to the original.
      const deletionOwner = `deletion:${randomUUID()}`;
      const rotatedClaims = new Map<string, { deletionToken: string; original: { taskId: string; token: string } | null }>();
      const releaseDeletionClaims = async (): Promise<void> => {
        for (const [id, r] of rotatedClaims) {
          await app.ctx.lockManager.releaseIfOwner(id, deletionOwner, r.deletionToken);
        }
        rotatedClaims.clear();
      };
      const rollbackClaims = async (): Promise<void> => {
        const failures: string[] = [];
        const restored: string[] = [];
        for (const [id, r] of rotatedClaims) {
          try {
            const ok = r.original
              ? await app.ctx.lockManager.rotateClaim(id, { taskId: deletionOwner, token: r.deletionToken }, r.original)
              : await app.ctx.lockManager.releaseIfOwner(id, deletionOwner, r.deletionToken);
            if (ok) restored.push(id);
            else failures.push(`${id}: deletion-owner claim no longer held; original owner not restored`);
          } catch (err) {
            failures.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // Clear only successfully-restored entries; keep failed ones as evidence for the caller/finally.
        for (const id of restored) rotatedClaims.delete(id);
        if (failures.length > 0) {
          throw new AggregateError(failures.map(f => new Error(f)), `lock rollback failed for ${failures.length} target(s)`);
        }
      };
      const rollbackAndRelease = async (): Promise<Error | null> => {
        let rollbackError: Error | null = null;
        // Rotate claims back to their original owners FIRST, so state restore sees the original claim.
        try {
          await rollbackClaims();
        } catch (err) {
          rollbackError = err instanceof Error ? err : new Error(String(err));
        }
        try {
          await rollbackPerTargetState(app, targets, originalStates);
        } catch (err) {
          const restoreError = err instanceof Error ? err : new Error(String(err));
          rollbackError = rollbackError
            ? new AggregateError([rollbackError, restoreError], 'Agent deletion rollback and lock release failed')
            : restoreError;
        }
        return rollbackError;
      };
      let claimedTargets: string[] = [];
      // True only after saveConfig commits: pre-commit escapes must rollback to the original owners; post-commit just releases.
      let committed = false;

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

        // Scan + tombstone-claim run atomically under the manager's task lock, blocking a concurrent createTask/dispatchPendingTask from committing onto a target mid-delete.
        const claim = await app.ctx.agentManager.scanActiveThenClaimDeletion(targets);
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
                  `Agent "${agentId}" is referenced by active task ${claim.taskId}; ` +
                  `cancel or finish that task before deleting (would dangle its dev/QA/retry reference).`,
              });
            case 'already-deleting':
              return reply.status(409).send({
                error: `Agent "${claim.agentId}" deletion already in progress; please wait and retry`,
              });
          }
        }
        claimedTargets = targets.slice();

        for (const id of targets) {
          const state = await app.ctx.agentStore.get(id);
          const claim = await app.ctx.lockManager.claimOf(id);
          const deletionToken = randomUUID();
          if (claim === null) {
            // No lock file (unbound, or a stale binding whose lock is gone): rotate from unbound == acquire.
            const ok = await app.ctx.lockManager.rotateClaim(id, { unbound: true }, { taskId: deletionOwner, token: deletionToken });
            if (!ok) {
              await rollbackClaims();
              return reply.status(409).send({
                error: `Agent "${id}" is currently locked by another op; please retry later`,
              });
            }
            rotatedClaims.set(id, { deletionToken, original: null });
            continue;
          }
          // A lock exists — only rotate it if it belongs to THIS agent's (now-terminal) task binding;
          // a lock owned by an unrelated live op must not be stolen.
          if (state?.taskId && claim.taskId !== state.taskId) {
            await rollbackClaims();
            return reply.status(409).send({
              error: `Agent "${id}" has a stale task binding whose exclusive lock is owned by another operation; retry after it finishes.`,
            });
          }
          if (!state?.taskId) {
            await rollbackClaims();
            return reply.status(409).send({
              error: `Agent "${id}" is currently locked by another op; please retry later`,
            });
          }
          const ok = await app.ctx.lockManager.rotateClaim(
            id,
            { taskId: claim.taskId, token: claim.token },
            { taskId: deletionOwner, token: deletionToken },
          );
          if (!ok) {
            await rollbackClaims();
            return reply.status(409).send({
              error: `Agent "${id}" lock changed while claiming it for deletion; please retry.`,
            });
          }
          rotatedClaims.set(id, { deletionToken, original: { taskId: claim.taskId, token: claim.token } });
        }

        for (const id of targets) {
          const existing = await app.ctx.agentStore.get(id);
          originalStates.set(id, existing);
        }

        originalConfigHash = configHash(app.ctx.config);
        const removeRequest = omitAgentsFromProject(app.ctx.config, projectId, targets);
        try {
          validatedAfterRemove = prepareConfig(removeRequest);
        } catch (err) {
          await rollbackClaims();
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
          : [{ agentId: agentId, step: 'runtime.cleanup', error: err }];
        app.log.error({ failures, targets },
          'DELETE /agents cleanupRemovedAgentRuntime failed; rolling back state and locks');
        const rollbackError = await withConfigLock(rollbackAndRelease);
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
          failures: failures.map(f => ({ agentId: f.agentId, step: f.step,
            error: f.error instanceof Error ? f.error.message : String(f.error) })),
        });
      }

      const phase3Result = await withConfigLock(async () => {
        const currentHash = configHash(app.ctx.config);
        const rollbackBase = currentHash === originalConfigHash
          ? validatedAfterRemove!
          : omitAgentsFromProject(app.ctx.config, projectId, targets);
        let validated: BaxianConfig;
        try {
          validated = prepareConfig(rollbackBase);
        } catch (err) {
          const rollbackError = await rollbackAndRelease();
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

        // Its only caller (saveConfig failure) runs before any state delete, so recovery is just rotating each claim back to its original owner.
        const restoreForRetry = async (): Promise<Error | null> => {
          try {
            await rollbackClaims();
            return null;
          } catch (e) {
            return e instanceof Error ? e : new Error(String(e));
          }
        };

        // Step 1 — commit config (atomic saveConfig) BEFORE any state delete: a crash between the two would else leave config referencing an agent whose state is gone, behind a stuck deletion:<uuid> lock (unrecoverable wedge).
        const warnings: string[] = [];
        try {
          await saveConfig(app.ctx.configPath!, validated);
        } catch (err) {
          app.log.error({ err, targets },
            'DELETE /agents Phase 3 saveConfig failed; releasing acquired locks (no state was deleted yet)');
          const restoreError = await restoreForRetry();
          if (restoreError) {
            return reply.status(500).send({
              error: `failed to persist config and roll the deletion locks back safely: ${restoreError.message}`,
            });
          }
          return reply.status(500).send({
            error: 'failed to persist config after runtime cleanup; this attempt\'s locks were released and agent state left intact',
          });
        }
        // Disk committed — point of no return. Bump the generation before any memory switch that could throw.
        committed = true;
        for (const id of targets) app.ctx.agentManager.bumpDeletionGeneration(id);

        // Step 2 — delete agent state POST-commit (best-effort): config already dropped these agents, so a failure here leaves only reclaimable orphan state.
        for (const id of targets) {
          try {
            await app.ctx.agentStore.delete(id);
          } catch (delErr) {
            const msg = `agent ${id} state delete failed post-commit (reclaimable orphan state): ${delErr instanceof Error ? delErr.message : String(delErr)}`;
            app.log.error({ err: delErr, agentId: id, targets }, `DELETE /agents Phase 3 ${msg}`);
            warnings.push(msg);
          }
        }

        // Step 3 — in-memory switch (never reverts; pollers cleared once). A throw here is a program bug: fail-stop by retaining the tombstone so nothing re-creates the id.
        try {
          app.ctx.config = validated;
          app.ctx.agentManager.replaceConfig(validated);
          app.ctx.tmuxProbePoller?.replaceConfig(validated);
          app.ctx.bootstrapPoller?.replaceConfig(validated);
          app.ctx.dispatchReconciler?.replaceConfig(validated);
        } catch (err) {
          for (const id of targets) app.ctx.agentManager.retainTombstoneForDivergence(id);
          app.log.fatal({ err, targets },
            'DELETE /agents Phase 3 replaceConfig threw AFTER disk commit; tombstone retained, restart advised');
        }

        // Step 4 — owner-scoped release of the deletion-owner claims + best-effort side cleanup; past the commit point, failures are surfaced as warnings, never rolled back.
        for (const id of targets) {
          const rotated = rotatedClaims.get(id);
          if (rotated) {
            try {
              await app.ctx.lockManager.releaseIfOwner(id, deletionOwner, rotated.deletionToken);
              rotatedClaims.delete(id);
            } catch (releaseErr) {
              warnings.push(`lock release for ${id} failed: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`);
              app.log.warn({ err: releaseErr, agentId: id }, 'DELETE /agents Phase 3 lock release failed (post-commit)');
            }
          }
          if (app.ctx.errorRecordStore) {
            try {
              await app.ctx.errorRecordStore.purgeAgent(id);
            } catch (purgeErr) {
              app.log.warn({ err: purgeErr, agentId: id }, 'DELETE /agents errorRecordStore.purgeAgent failed');
            }
          }
          if (app.ctx.petStore) {
            try {
              await app.ctx.petStore.setAssignment(id, null);
            } catch (petErr) {
              app.log.warn({ err: petErr, agentId: id }, 'DELETE /agents petStore.setAssignment(null) failed');
            }
          }
        }
        return reply.send({ removed: targets, restartRequired: false, ...(warnings.length ? { warnings } : {}) });
      });
      return phase3Result;
      } finally {
        // Leftover rotated claims (normal paths clear them): pre-commit escapes roll back to the original owners; releasing pre-commit would strand a lockless binding. Post-commit the agents are gone, so just release.
        if (rotatedClaims.size > 0) {
          const cleanup = committed ? releaseDeletionClaims() : rollbackClaims();
          await cleanup.catch((err) => {
            app.log.error({ err, committed }, 'DELETE /agents: leftover deletion-claim cleanup failed');
          });
        }
        if (claimedTargets.length > 0) {
          app.ctx.agentManager.releaseDeletionClaim(claimedTargets);
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
        // Generation-gated: a DELETE→recreate during ensureSession leaves a NEW state, so an existing-only check would bind the stale paneId to the wrong incarnation.
        const paneCommit = await app.ctx.agentStore.update(agentId, (existing) => {
          if (!existing
              || app.ctx.agentManager.isDeletionInFlight(agentId)
              || app.ctx.agentManager.deletionGenerationOf(agentId) !== genAtEntry) {
            return AGENT_STORE_NOOP;
          }
          return { ...existing, paneId: result.paneId, updatedAt: now };
        });
        // No-op ⇒ a DELETE→recreate raced ensureSession; fail closed rather than run stale retry cleanup against the new incarnation.
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

function findConfiguredWorkdirConflict(config: BaxianConfig, candidate: AgentConfig): string | null {
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
  const candidateHost = workdirHostGroupKey(
    candidate.mode,
    resolvedCandidateHost,
  );
  const candidatePath = normalize(candidate.workdir);
  for (const project of config.project) {
    for (const existing of project.agent.flat()) {
      if (!existing.workdir) continue;
      const existingHost = workdirHostGroupKey(
        existing.mode,
        resolveAgentHost(config.host, existing.host),
      );
      if (existingHost === candidateHost && normalize(existing.workdir) === candidatePath) {
        return existing.id;
      }
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
      // Bound to the pre-restart task tuple: a successor pass rotated mid-replay must not be held.
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
  // Both fences ride inside the release itself: a hold or pass rotation landing after any pre-read survives.
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

async function rollbackPerTargetState(
  app: FastifyInstance,
  targets: string[],
  originalStates: Map<string, AgentBindingFacts | null>,
): Promise<void> {
  const failures: Error[] = [];
  for (const id of targets) {
    const original = originalStates.get(id) ?? null;
    if (!original) {
      try {
        await app.ctx.agentStore.delete(id);
      } catch (err) {
        failures.push(new Error(`delete transient state for ${id}: ${err instanceof Error ? err.message : String(err)}`));
      }
      continue;
    }
    try {
      let lockToken = original.lockToken;
      if (original.taskId) {
        const claim = await app.ctx.lockManager.claimOf(id);
        if (claim?.taskId === original.taskId) {
          lockToken = claim.token;
        } else if (claim === null) {
          lockToken = await app.ctx.lockManager.acquire(id, original.taskId) ?? undefined;
        } else {
          throw new Error(`lock is owned by ${claim.taskId}, expected ${original.taskId}`);
        }
        if (!lockToken || !(await app.ctx.lockManager.isOwner(id, original.taskId, lockToken))) {
          throw new Error(`could not restore exact task lock for ${original.taskId}`);
        }
      }
      await app.ctx.agentStore.set({
        ...original,
        ...(original.taskId ? { lockToken } : { lockToken: undefined }),
        paneId: undefined,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      failures.push(new Error(`restore state for ${id}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to roll back ${failures.length} agent deletion state(s)`);
  }
}
