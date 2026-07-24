import type { FastifyInstance } from 'fastify';
import { normalize } from 'node:path';
import type { BaxianConfig, HttpsConfig, HostConfig, ProjectConfig, RootAgentConfig } from '../shared/index.js';
import { autoBootstrapAgentIds } from '../agent/bootstrap.js';
import {
  saveConfig,
  prepareConfig,
  ConfigValidationError,
} from '../config/loader.js';
import { withConfigLock } from '../config/mutex.js';
import { applyConfigHotReload, prepareConfigHotReload } from '../config/hot-reload.js';
import { activeParticipantBlockers, gitBindingBlockerDetails, gitBindingBlockers } from './platform-guard.js';
import { agentIsLive } from '../agent/liveness.js';

function hostRefKey(host: unknown): string {
  return JSON.stringify(host ?? null);
}

function agentHostRefs(projects: ProjectConfig[] | undefined): Map<string, string> {
  const refs = new Map<string, string>();
  for (const project of projects ?? []) {
    for (const pair of project?.agent ?? []) {
      for (const agent of pair ?? []) {
        if (agent && typeof agent.id === 'string') refs.set(agent.id, hostRefKey(agent.host));
      }
    }
  }
  return refs;
}

function agentWorkdirRefs(projects: ProjectConfig[] | undefined): Map<string, string> {
  const refs = new Map<string, string>();
  for (const project of projects ?? []) {
    for (const pair of project?.agent ?? []) {
      for (const agent of pair ?? []) {
        if (agent && typeof agent.id === 'string') {
          refs.set(agent.id, agent.workdir === undefined ? '' : normalize(agent.workdir));
        }
      }
    }
  }
  return refs;
}

function agentPermissionRefs(projects: ProjectConfig[] | undefined): Map<string, string> {
  const refs = new Map<string, string>();
  for (const project of projects ?? []) {
    for (const pair of project?.agent ?? []) {
      for (const agent of pair ?? []) {
        if (!agent || typeof agent.id !== 'string') continue;
        const addDirs = [...new Set((agent.addDirs ?? []).map(path => normalize(path)))].sort();
        refs.set(agent.id, JSON.stringify([agent.yolo !== false, addDirs]));
      }
    }
  }
  return refs;
}

const REDACTED = '***';

function requiresRestart(prev: BaxianConfig, next: BaxianConfig): boolean {
  return prev.server.host !== next.server.host
    || prev.server.port !== next.server.port
    || !sameHttps(prev.server.https, next.server.https)
    || JSON.stringify(prev.root ?? null) !== JSON.stringify(next.root ?? null);
}

function rootRuntimeKey(root: RootAgentConfig | undefined): string {
  if (!root) return 'none';
  return JSON.stringify([
    root.runtime,
    root.mode,
    hostRefKey(root.host),
    normalize(root.workdir),
    root.yolo ?? true,
    root.model ?? null,
  ]);
}

function rootRuntimeChanged(prev: RootAgentConfig | undefined, next: RootAgentConfig | undefined): boolean {
  return rootRuntimeKey(prev) !== rootRuntimeKey(next);
}

function sameHttps(a: HttpsConfig | undefined, b: HttpsConfig | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.keyFile === b.keyFile && a.certFile === b.certFile;
}

function resolveSensitive(incoming: string | undefined, current: string | undefined): string | undefined {
  if (incoming === REDACTED) return current;
  if (incoming === undefined) return current;
  return incoming;
}

function redactHostSecret(host: HostConfig): HostConfig {
  return host.password !== undefined ? { ...host, password: REDACTED } : host;
}

function redactAgentHostRef(host: string | HostConfig | undefined): string | HostConfig | undefined {
  return host && typeof host === 'object' ? redactHostSecret(host) : host;
}

export function redactHosts(hosts: HostConfig[]): HostConfig[] {
  return hosts.map(redactHostSecret);
}

export function redactProjects(projects: ProjectConfig[]): ProjectConfig[] {
  return projects.map(p => ({
    ...p,
    agent: p.agent.map(pair => pair.map(a => ({ ...a, host: redactAgentHostRef(a.host) }))),
  }));
}

export function redactConfig(config: BaxianConfig): BaxianConfig {
  return {
    ...config,
    server: {
      ...config.server,
      ...(config.server.token !== undefined ? { token: REDACTED } : {}),
    },
    host: redactHosts(config.host ?? []),
    project: redactProjects(config.project ?? []),
    ...(config.root ? { root: redactRoot(config.root) } : {}),
  };
}

function redactRoot(root: RootAgentConfig): RootAgentConfig {
  return {
    ...root,
    ...(root.host !== undefined ? { host: redactAgentHostRef(root.host) } : {}),
  };
}

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get('/config', async () => {
    return redactConfig(app.ctx.config);
  });

  app.patch<{ Body: Partial<BaxianConfig> }>('/config', async (request, reply) => {
    if (!app.ctx.configPath) {
      return reply.status(500).send({ error: 'No config path configured' });
    }
    return withConfigLock(async () => {
      const current = app.ctx.config;
      const rawBody = request.body;
      if (
        rawBody === null
        || rawBody === undefined
        || typeof rawBody !== 'object'
        || Array.isArray(rawBody)
      ) {
        return reply.status(400).send({
          error: 'Invalid config',
          details: [{ path: '', message: 'request body must be a JSON object' }],
        });
      }
      const incoming = rawBody as Partial<BaxianConfig> & Record<string, unknown>;

      if ('host' in incoming) {
        return reply.status(400).send({
          error: 'Invalid config',
          details: [{ path: 'host', message: 'host registry is managed via /hosts/*; do not include "host" in PATCH /config' }],
        });
      }

      const incomingServer: Partial<BaxianConfig['server']> = incoming.server ?? {};
      const resolvedToken = resolveSensitive(incomingServer.token, current.server.token);
      const mergedServer: BaxianConfig['server'] = {
        ...current.server,
        ...incomingServer,
        ...(resolvedToken !== undefined ? { token: resolvedToken } : { token: undefined }),
      };
      if (mergedServer.token === undefined) {
        delete (mergedServer as Partial<BaxianConfig['server']>).token;
      }

      const merged: BaxianConfig = {
        language: ('language' in incoming ? incoming.language : current.language) as BaxianConfig['language'],
        review: { ...current.review, ...(incoming.review ?? {}) },
        server: mergedServer,
        host: current.host,
        project: incoming.project ?? current.project,
        ...('root' in incoming
          ? (incoming.root == null ? {} : { root: incoming.root })
          : (current.root ? { root: current.root } : {})),
      };

      let validated: BaxianConfig;
      try {
        validated = prepareConfig(merged);
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          return reply.status(400).send({
            error: 'Invalid config',
            details: err.errors,
          });
        }
        throw err;
      }

      if (incoming.project !== undefined) {
        const currentHosts = agentHostRefs(current.project);
        const currentWorkdirs = agentWorkdirRefs(current.project);
        const currentPermissions = agentPermissionRefs(current.project);
        const nextHosts = agentHostRefs(validated.project);
        const nextWorkdirs = agentWorkdirRefs(validated.project);
        const nextPermissions = agentPermissionRefs(validated.project);
        // A hot reload must not resurrect OR retain an id whose DELETE is in flight/diverged (fail-stop):
        // checking only new ids let a PATCH move an existing deleting id (host/workdir unchanged) to another
        // project and survive the DELETE's hash-mismatch removal. Any deleting id in the next config → 409.
        for (const [agentId] of nextHosts) {
          if (app.ctx.agentManager.isDeletionInFlight(agentId)) {
            return reply.status(409).send({
              error: `Agent id "${agentId}" is being deleted (or its deletion diverged); cannot keep or (re)introduce it via config reload`,
            });
          }
        }
        const blockedHosts: string[] = [];
        const blockedWorkdirs: string[] = [];
        const blockedPermissions: string[] = [];
        const blockedRemovals: string[] = [];
        for (const [agentId, nextHost] of nextHosts) {
          if (!currentHosts.has(agentId)) continue;
          const hostChanged = currentHosts.get(agentId) !== nextHost;
          const workdirChanged = currentWorkdirs.get(agentId) !== nextWorkdirs.get(agentId);
          const permissionsChanged = currentPermissions.get(agentId) !== nextPermissions.get(agentId);
          if (!hostChanged && !workdirChanged && !permissionsChanged) continue;
          if (!await agentIsLive(app.ctx, agentId)) continue;
          if (hostChanged) blockedHosts.push(agentId);
          if (workdirChanged) blockedWorkdirs.push(agentId);
          if (permissionsChanged) blockedPermissions.push(agentId);
        }
        for (const agentId of currentHosts.keys()) {
          if (!nextHosts.has(agentId) && await agentIsLive(app.ctx, agentId)) {
            blockedRemovals.push(agentId);
          }
        }
        if (
          blockedHosts.length > 0
          || blockedWorkdirs.length > 0
          || blockedPermissions.length > 0
          || blockedRemovals.length > 0
        ) {
          const changes = [
            ...(blockedHosts.length > 0 ? [`host of ${blockedHosts.join(', ')}`] : []),
            ...(blockedWorkdirs.length > 0 ? [`Workdir of ${blockedWorkdirs.join(', ')}`] : []),
            ...(blockedPermissions.length > 0 ? [`permissions/addDirs of ${blockedPermissions.join(', ')}`] : []),
            ...(blockedRemovals.length > 0 ? [`configuration entry for ${blockedRemovals.join(', ')}`] : []),
          ].join(' or ');
          return reply.status(409).send({
            error: `cannot change the ${changes} while the agent is live; stop its session first`,
          });
        }
      }

      if (rootRuntimeChanged(current.root, validated.root) && app.ctx.rootRecoveryCoordinator) {
        const coordinator = app.ctx.rootRecoveryCoordinator;
        if (!coordinator.isRuntimeExplicitlyStopped()) {
          return reply.status(409).send({
            error: 'cannot change or remove root runtime configuration until root-agent is explicitly stopped',
          });
        }
        try {
          if (await coordinator.isRuntimeLive()) {
            return reply.status(409).send({
              error: 'root-agent became live after it was stopped; stop it again before changing root configuration',
            });
          }
        } catch (err) {
          return reply.status(503).send({
            error: `cannot verify that root-agent is stopped: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      try {
        await app.ctx.agentManager.ensurePluginSkillPools(validated);
      } catch (err) {
        return reply.status(400).send({
          error: `git-driver plugin skill pool is unusable for this config: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const mustRestart = requiresRestart(current, validated);
      const committed = await app.ctx.agentManager.guardGitConfigCommit(
        current,
        validated,
        async (manager, cur, next) => [
          ...(await gitBindingBlockers(manager, cur, next)),
          ...(await activeParticipantBlockers(manager, cur, next)),
        ],
        async () => {
          const hotReload = await prepareConfigHotReload(app.ctx, validated);
          await saveConfig(app.ctx.configPath!, validated);
          app.ctx.config = validated;
          await applyConfigHotReload(app.ctx, validated, hotReload);
        },
      );
      if (!committed.ok) {
        return reply.status(409).send({
          error:
            'cannot apply platform configuration while active tasks lock a project identity, repository, or participant agents; '
            + 'inspect details, then finish or cancel the listed tasks',
          blockers: committed.blockers,
          details: gitBindingBlockerDetails(committed.blockers),
        });
      }

      if (app.ctx.errorRecordStore) {
        try {
          await app.ctx.errorRecordStore.sweepStaleBootstrapErrors(autoBootstrapAgentIds(validated));
        } catch (purgeErr) {
          app.log.warn({ err: purgeErr }, 'PATCH /config sweepStaleBootstrapErrors failed');
        }
      }
      return reply.send({
        config: redactConfig(validated),
        restartRequired: mustRestart,
        note: mustRestart
          ? 'Saved and hot-reloadable fields applied. server.host/port/https or root changes require a restart to take effect.'
          : 'Saved and applied immediately (no restart required).',
      });
    });
  });
}
