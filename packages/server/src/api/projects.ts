import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentMode,
  AgentBindingFacts,
  BaxianConfig,
  ProjectConfig,
  MergeStrategy,
  AgentConfig,
} from '../shared/index.js';
import { TASK_ACTIVE_STATUS_SET, TASK_TERMINAL_STATUS_SET } from '../shared/index.js';
import { runPreflight, type PreflightResult } from '../agent/preflight.js';
import { createRunner, resolveAgentHost } from '../agent/runner.js';
import { saveConfig, prepareConfig, ConfigValidationError } from '../config/loader.js';
import { withConfigLock } from '../config/mutex.js';
import { redactProjects } from './config.js';
import { CleanupFailedError, EnsureSessionError } from '../agent/manager.js';
import { TmuxManager } from '../agent/tmux.js';
import { applyConfigHotReload } from '../config/hot-reload.js';

interface CheckRun {
  agentId: string;
  mode: AgentMode;
  results: PreflightResult[];
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
    // Use the poller's view of config (not app.ctx.config) as the source of truth — PATCH /config
    // updates ctx.config but only DELETE /agents currently hot-replaces the poller, so during the
    // PATCH-then-restart window ctx.config can list projects the poller doesn't know yet.
    const result = await app.ctx.bootstrapPoller.pollProject(request.params.id);
    if (!result.knownProject) {
      return reply.status(404).send({
        error: `Project "${request.params.id}" not found in active bootstrap config (a recent PATCH /config may need a server restart to take effect)`,
      });
    }
    if (result.ran === 0) {
      // Project exists but has no auto-mode agents (all have explicit workdir) → success no-op.
      return reply.send({ ok: true, ran: 0, message: 'no bootstrap targets for this project' });
    }
    return reply.send({ ok: result.ok, ran: result.ran });
  });

  app.post<{ Params: { id: string } }>('/projects/:id/checks', async (request, reply) => {
    const project = app.ctx.config.project.find(p => p.id === request.params.id);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const checks: Promise<CheckRun>[] = [];
    for (const pair of project.agent) {
      for (const agent of pair) {
        const host = resolveAgentHost(app.ctx.config.host, agent.host);
        const runner = createRunner(agent.mode, host);
        checks.push(
          runPreflight(runner, agent, project.repo, host).then(results => ({
            agentId: agent.id,
            mode: agent.mode,
            results,
          })),
        );
      }
    }
    const agents = await Promise.all(checks);
    return reply.status(201).send({ projectId: project.id, agents });
  });

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
            `delete every agent (which reclaims its tmux session / worktree) before deleting the project.`,
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

      await saveConfig(app.ctx.configPath!, validated);
      app.ctx.config = validated;
      applyConfigHotReload(app.ctx, validated);
      return reply.status(200).send({ removed: id, restartRequired: false });
    });
  });

  app.post<{ Body: { id?: string; repo?: string; merge?: MergeStrategy; review?: ProjectConfig['review'] } }>(
    '/projects',
    async (request, reply) => {
      if (!app.ctx.configPath) {
        return reply.status(500).send({ error: 'No config path configured' });
      }

      return withConfigLock(async () => {
        const { id, repo, merge, review } = request.body ?? {};
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

  // Config commit precedes bootstrap; failures emit events instead of rolling back config.
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

    if (agentInput.role !== 'dev' && agentInput.role !== 'qa') {
      return reply.status(400).send({ error: 'role must be "dev" or "qa"' });
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

      if (agentInput.role === 'qa') {
        if (!pairWith) {
          return reply.status(400).send({ error: 'pairWith required when role=qa' });
        }
        const targetPair = project.agent.find(
          pair => pair.length === 1 && pair[0].id === pairWith && pair[0].role === 'dev',
        );
        if (!targetPair) {
          return reply.status(400).send({
            error: `pairWith "${pairWith}" must reference a dev agent in this project that has no qa yet`,
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
        return reply.status(400).send({ error: 'pairWith only valid for role=qa' });
      }

      const newProjects = app.ctx.config.project.map((p) => {
        if (p.id !== projectId) return p;
        if (agentInput.role === 'dev') {
          return { ...p, agent: [...p.agent, [agentInput as AgentConfig]] };
        }
        const newAgent = p.agent.map(pair => {
          if (pair.length === 1 && pair[0].id === pairWith) {
            return [...pair, agentInput as AgentConfig];
          }
          return pair;
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
      const acquiredLocks: string[] = [];
      let claimedTargets: string[] = [];

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

        for (const id of targets) {
          const state = await app.ctx.agentStore.get(id);
          const task = state?.taskId ? await app.ctx.taskStore.get(state.taskId) : null;
          // active task 始终拒——即使 awaiting_human 也不行，否则会留 orphan task 指向已删 agent。
          // operator 必须先 cancelTask 让 task 进 cancelled，再 DELETE。
          // active 含 max_rounds：其 dev 是 reserved 态（持锁+worktree），删它同样会留 orphan。
          if (task && TASK_ACTIVE_STATUS_SET.has(task.status)) {
            return reply.status(409).send({
              error:
                `Agent "${id}" is still active on task ${task.id}; cancel the task before deleting ` +
                `(prevents orphan task / tmux session / lock / worktree).`,
            });
          }
          // awaiting_human + 无活跃 task = 合法回收出口。
          if (state?.status === 'awaiting_human') continue;
          if (state?.creationToken) {
            return reply.status(409).send({
              error:
                `Agent "${id}" is bootstrapping; retry shortly or wait for it to enter awaiting_human state.`,
            });
          }
        }

        // An active task can reference a target it no longer has BOUND — e.g. a spec-phase
        // max_rounds task whose dev/QA were released (agentId/qaAgentId cleared) but whose
        // preferredAgentId is kept for Retry. The binding-based checks above miss that; deleting
        // the agent would dangle the reference and break Retry. Refuse if any active task names a
        // target via preferredAgentId / agentId / qaAgentId.
        const targetSet = new Set(targets);
        const referencing = (await app.ctx.taskStore.list({})).find(t =>
          TASK_ACTIVE_STATUS_SET.has(t.status)
          && ((t.preferredAgentId !== '' && targetSet.has(t.preferredAgentId))
            || (!!t.agentId && targetSet.has(t.agentId))
            || (!!t.qaAgentId && targetSet.has(t.qaAgentId))),
        );
        if (referencing) {
          return reply.status(409).send({
            error:
              `Agent "${agentId}" is referenced by active task ${referencing.id}; ` +
              `cancel or finish that task before deleting (would dangle its dev/QA/retry reference).`,
          });
        }

        // claim deletion 占位：挡住第二个 DELETE 在 awaiting_human stale-lock takeover 路径下
        // 撞同一 agent → 否则 phase2 (cleanupRemovedAgentRuntime) 会并发 kill 同一 tmux/worktree。
        const conflict = app.ctx.agentManager.tryClaimDeletion(targets);
        if (conflict) {
          return reply.status(409).send({
            error: `Agent "${conflict}" deletion already in progress; please wait and retry`,
          });
        }
        claimedTargets = targets.slice();

        for (const id of targets) {
          const ok = await app.ctx.lockManager.acquire(id);
          if (!ok) {
            // awaiting_human 状态下 lock 是前任 op 留下的 stale lock（markAwaitingHuman 不释放
            // lock），DELETE 是显式回收入口，直接接管——不计入 acquiredLocks，cleanupRemovedAgentRuntime
            // 会一并删除 stale lock 文件。deletionInFlight claim 已挡住并发 DELETE。
            const state = await app.ctx.agentStore.get(id);
            if (state?.status === 'awaiting_human') continue;
            for (const got of acquiredLocks) {
              await app.ctx.lockManager.release(got);
            }
            return reply.status(409).send({
              error: `Agent "${id}" is currently locked by another op; please retry later`,
            });
          }
          acquiredLocks.push(id);
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
          for (const got of acquiredLocks) await app.ctx.lockManager.release(got);
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
        if (err instanceof CleanupFailedError) {
          app.log.error({ failures: err.failures, targets },
            'DELETE /agents cleanupRemovedAgentRuntime failed; rolling back deletion marker');
          await withConfigLock(async () => {
            await rollbackPerTargetState(app, targets, originalStates);
            for (const got of acquiredLocks) await app.ctx.lockManager.release(got);
          });
          return reply.status(502).send({
            error:
              `runtime cleanup failed for ${targets.join(',')}; agent state rolled back ` +
              `to idle+missing. Fix the underlying SSH / tmux / worktree issue and retry DELETE.`,
            failures: err.failures.map(f => ({ agentId: f.agentId, step: f.step,
              error: f.error instanceof Error ? f.error.message : String(f.error) })),
          });
        }
        app.log.warn({ err, targets },
          'DELETE /agents cleanupRemovedAgentRuntime threw an unrecognised error — proceeding to commit anyway');
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
          await rollbackPerTargetState(app, targets, originalStates);
          for (const got of acquiredLocks) await app.ctx.lockManager.release(got);
          if (err instanceof ConfigValidationError) {
            return reply.status(400).send({ error: 'Invalid config', details: err.errors });
          }
          throw err;
        }
        try {
          await saveConfig(app.ctx.configPath!, validated);
        } catch (err) {
          app.log.error({ err, targets },
            'DELETE /agents Phase 3 saveConfig failed; rolling agent state back to idle+missing');
          await rollbackPerTargetState(app, targets, originalStates);
          for (const got of acquiredLocks) await app.ctx.lockManager.release(got);
          return reply.status(500).send({
            error: 'failed to persist config after runtime cleanup; agents marked idle+missing for retry',
          });
        }
        app.ctx.config = validated;
        app.ctx.agentManager.replaceConfig(validated);
        app.ctx.tmuxProbePoller?.replaceConfig(validated);
        app.ctx.bootstrapPoller?.replaceConfig(validated);
        for (const id of targets) {
          try {
            await app.ctx.agentStore.delete(id);
          } catch (delErr) {
            app.log.warn({ err: delErr, agentId: id },
              'DELETE /agents Phase 3 agentStore.delete failed');
          }
          // Clear stale error records so reusing the same agent id (delete + recreate) doesn't
          // inherit the previous incarnation's bootstrap failures in the new snapshot.
          // Best-effort; failure is logged but doesn't block deletion.
          if (app.ctx.errorRecordStore) {
            try {
              await app.ctx.errorRecordStore.purgeAgent(id);
            } catch (purgeErr) {
              app.log.warn({ err: purgeErr, agentId: id },
                'DELETE /agents errorRecordStore.purgeAgent failed');
            }
          }
          // Same reason as the error-record purge: drop the pet assignment so reusing the
          // agent id (delete + recreate) doesn't inherit the previous incarnation's pet.
          if (app.ctx.petStore) {
            try {
              await app.ctx.petStore.setAssignment(id, null);
            } catch (petErr) {
              app.log.warn({ err: petErr, agentId: id },
                'DELETE /agents petStore.setAssignment(null) failed');
            }
          }
          await app.ctx.lockManager.release(id);
        }
        return reply.send({ removed: targets, restartRequired: false });
      });
      return phase3Result;
      } finally {
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
      // withConfigLock 与 DELETE / create-agent 同一把锁串行化——避免 operator 同时
      // 发起 DELETE 和 Resume 时，Resume 把 state 改回 ok，而 DELETE 的
      // cleanupRemovedAgentRuntime 还在杀 tmux/删 worktree。
      return withConfigLock(async () => {
        // DELETE phase2 (cleanupRemovedAgentRuntime) 在 phase1 释放 withConfigLock 后无锁运行；
        // 期间 Resume 拿到 withConfigLock 仍可能撞——deletionInFlight claim 跨 phase 持有，拒绝 Resume。
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
            : 'Resume rejected; agent not in a state that can be resumed.';
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

      const owner = await resolveLockOwnership(app, agentId);
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
        const ok = await app.ctx.lockManager.acquire(agentId);
        if (!ok) {
          return reply.status(409).send({ error: `Agent "${agentId}" is locked by another op; please retry later` });
        }
      }

      try {
        await app.ctx.agentManager.restartReplOnly(agentId);
      } catch (err) {
        if (!owner.takeover) await app.ctx.lockManager.release(agentId);
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
      await pendingCleanupAfterReplReady(app, agentId, owner.takeover);
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
      if (!owner.takeover) {
        const ok = await app.ctx.lockManager.acquire(agentId);
        if (!ok) {
          return reply.status(409).send({ error: `Agent "${agentId}" is locked by another op; please retry later` });
        }
      }

      try {
        const result = await app.ctx.agentManager.ensureSession(agentId, 'runtime');
        const now = new Date().toISOString();
        const stateAfter = await app.ctx.agentStore.get(agentId);
        await app.ctx.agentStore.set({
          ...(stateAfter ?? { id: agentId, projectId, updatedAt: now }),
          paneId: result.paneId,
          updatedAt: now,
        });
      } catch (err) {
        // dialogPending check must precede createdSession-kill (kill strips dismiss handle).
        if (await app.ctx.agentManager.handleDialogPendingFromRuntime(agentId, err)) {
          if (!owner.takeover) await app.ctx.lockManager.release(agentId);
          return reply.status(202).send({
            ok: true,
            agentId,
            runtimeStatus: 'pending',
            message:
              'REPL launched but blocked on a startup dialog; open the web ' +
              'terminal to dismiss — baxian will auto-detect ready and resume',
          });
        }
        if (err instanceof EnsureSessionError && err.partial.createdSession) {
          try {
            const runner = createRunner(cfg.mode, resolveAgentHost(app.ctx.config.host, cfg.host));
            await new TmuxManager(runner).killSession(agentId);
          } catch (cleanupErr) {
            app.log.warn({ err: cleanupErr, agentId },
              'POST /retry ensureSession rollback killSession failed');
          }
        }
        if (!owner.takeover) await app.ctx.lockManager.release(agentId);
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
      await pendingCleanupAfterReplReady(app, agentId, owner.takeover);
      return reply.send({ ok: true, agentId });
    },
  );
}

interface LockOwner {
  takeover: boolean;
}

/** dev keeps its lock across the fix loop — restart/retry must reuse it. */
async function resolveLockOwnership(
  app: FastifyInstance,
  agentId: string,
): Promise<LockOwner> {
  const cfg = app.ctx.agentManager.getAgentConfig(agentId);
  if (!cfg || cfg.role !== 'dev') return { takeover: false };
  const state = await app.ctx.agentStore.get(agentId);
  if (!state?.taskId) return { takeover: false };
  const task = await app.ctx.taskStore.get(state.taskId);
  if (!task) return { takeover: false };
  // max_rounds 含在内：reserved dev 持锁，restart/retry 应保留锁（takeover），勿误 release。
  if (!TASK_ACTIVE_STATUS_SET.has(task.status)) return { takeover: false };
  const locked = await app.ctx.lockManager.isLocked(agentId);
  if (!locked) return { takeover: false };
  return { takeover: true };
}

/** Returns null when the agent is open for ops. */
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

/** Terminal task → idle release; active task → mark waiting (keeps lock). */
async function pendingCleanupAfterReplReady(
  app: FastifyInstance,
  agentId: string,
  takeover: boolean,
): Promise<void> {
  const state = await app.ctx.agentStore.get(agentId);
  const taskId = state?.taskId;
  if (!taskId) {
    await app.ctx.agentManager.clearAwaitingHuman(agentId);
    if (!takeover) await app.ctx.lockManager.release(agentId);
    return;
  }
  const task = await app.ctx.taskStore.get(taskId);
  // restart-repl / retry 是显式 operator 操作，已确认 REPL 重启；前面的 ack_unknown/dev-wait-gate-failed/
  // dialog_pending Held 状态都因新 REPL 而不再成立 → 用 allowAwaitingHuman + clearAwaitingHuman 清掉。
  // 否则 endpoint 返回 200 但 agent 仍 Held + Resume 也拒，operator 卡死。
  // max_rounds 非终态：reserved dev restart 后走 markWaiting 保锁+worktree，不被误 idle-release 删 worktree。
  if (!task || TASK_TERMINAL_STATUS_SET.has(task.status)) {
    await app.ctx.agentManager.releaseAgentForTask(agentId, taskId, 'idle', { allowAwaitingHuman: true })
      .catch(err => app.log.warn({ err, agentId, taskId }, 'restart/retry idle-release failed'));
    return;
  }
  await app.ctx.agentManager.markAgentWaiting(agentId, taskId, {
    allowAwaitingHuman: true,
    clearAwaitingHuman: true,
  });
}

async function rollbackPerTargetState(
  app: FastifyInstance,
  targets: string[],
  originalStates: Map<string, AgentBindingFacts | null>,
): Promise<void> {
  for (const id of targets) {
    const original = originalStates.get(id) ?? null;
    if (!original) {
      try { await app.ctx.agentStore.delete(id); } catch {}
      continue;
    }
    try {
      await app.ctx.agentStore.set({
        ...original,
        paneId: undefined,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      app.log.warn({ err, agentId: id }, 'DELETE /agents rollback agentStore.set failed');
    }
  }
}
