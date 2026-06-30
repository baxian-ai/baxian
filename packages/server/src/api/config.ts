import type { FastifyInstance } from 'fastify';
import type { BaxianConfig, HttpsConfig, HostConfig, ProjectConfig } from '../shared/index.js';
import { autoBootstrapAgentIds } from '../agent/bootstrap.js';
import {
  saveConfig,
  prepareConfig,
  ConfigValidationError,
} from '../config/loader.js';
import { withConfigLock } from '../config/mutex.js';
import { applyConfigHotReload } from '../config/hot-reload.js';
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

const REDACTED = '***';

function requiresRestart(prev: BaxianConfig['server'], next: BaxianConfig['server']): boolean {
  return prev.host !== next.host
    || prev.port !== next.port
    || !sameHttps(prev.https, next.https);
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

      const legacyErrors: Array<{ path: string; message: string }> = [];
      if ('codereview' in incoming) {
        legacyErrors.push({
          path: 'codereview',
          message: 'codereview was renamed to review — rename the top-level key in the request body',
        });
      }
      if (legacyErrors.length > 0) {
        return reply.status(400).send({ error: 'Invalid config', details: legacyErrors });
      }

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
        review: { ...current.review, ...(incoming.review ?? {}) },
        server: mergedServer,
        host: current.host,
        project: incoming.project ?? current.project,
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
        const currentRefs = agentHostRefs(current.project);
        const blocked: string[] = [];
        for (const [agentId, ref] of agentHostRefs(validated.project)) {
          const prev = currentRefs.get(agentId);
          if (prev !== undefined && prev !== ref && await agentIsLive(app.ctx, agentId)) {
            blocked.push(agentId);
          }
        }
        if (blocked.length > 0) {
          return reply.status(409).send({
            error: `cannot change the host of live agent(s) ${blocked.join(', ')}; stop their sessions first`,
          });
        }
      }

      await saveConfig(app.ctx.configPath!, validated);
      app.ctx.config = validated;

      const mustRestart = requiresRestart(current.server, validated.server);
      if (!mustRestart) {
        applyConfigHotReload(app.ctx, validated);
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
          ? 'Saved. server.host/port/https changes require a restart to take effect.'
          : 'Saved and applied immediately (no restart required).',
      });
    });
  });
}
