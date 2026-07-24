import type { FastifyInstance } from 'fastify';
import type { HostConfig, BaxianConfig } from '../shared/index.js';
import { ROOT_AGENT_ID } from '../shared/index.js';
import type { CommandRunner } from '../agent/runner.js';
import {
  LocalRunner,
  buildSshOptions,
  sshTarget,
  sshEnv,
  ensureMuxDir,
  shellQuote,
} from '../agent/runner.js';
import { agentIsLive } from '../agent/liveness.js';
import { saveConfig, prepareConfig, ConfigValidationError } from '../config/loader.js';
import { withConfigLock } from '../config/mutex.js';
import { applyConfigHotReload, prepareConfigHotReload } from '../config/hot-reload.js';
import { redactHosts } from './config.js';

const REDACTED = '***';
const CHECK_TIMEOUT_MS = 5000;

interface HostBody {
  id?: string;
  hostname?: string;
  port?: number | null;
  alias?: string;
  user?: string;
  password?: string;
}

export interface HostRoutesOptions {
  localRunnerFactory?: () => CommandRunner;
}

async function checkHostConnectivity(
  host: HostConfig,
  makeLocal: () => CommandRunner,
): Promise<{ ok: boolean; message: string }> {
  await ensureMuxDir();
  const target = sshTarget(host);
  const sshCmd = `ssh ${buildSshOptions(host, { connectTimeoutSec: 5, noMux: true })} -- ${shellQuote(target)} echo ok`;
  const env = await sshEnv(host);
  const result = await makeLocal()
    .exec(sshCmd, { timeout: CHECK_TIMEOUT_MS, ...(Object.keys(env).length ? { env } : {}) })
    .catch(err => ({ stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 1 }));
  const ok = result.exitCode === 0 && result.stdout.includes('ok');
  const tail = (result.stderr || '').trim().split('\n').pop() ?? '';
  return {
    ok,
    message: ok ? 'SSH OK' : `SSH 不通：检查地址 / 端口 / 密码或 key 认证${tail ? ` (${tail})` : ''}`,
  };
}

function slugifyHostId(base: string): string {
  let s = (base || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '');
  return s.length >= 2 ? s : 'host';
}

function generateHostId(base: string, existing: Set<string>): string {
  const root = slugifyHostId(base);
  if (!existing.has(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const cand = `${root.slice(0, 32 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!existing.has(cand)) return cand;
  }
  return `host-${existing.size + 1}`;
}

function resolvePassword(incoming: string | undefined, current: string | undefined): string | undefined {
  if (incoming === REDACTED || incoming === undefined) return current;
  return incoming;
}

function structuralChange(prev: HostConfig, next: HostConfig): boolean {
  return prev.hostname !== next.hostname
    || (prev.user ?? '') !== (next.user ?? '')
    || prev.port !== next.port;
}

function sameConnection(a: HostConfig, b: HostConfig): boolean {
  return a.hostname === b.hostname
    && a.port === b.port
    && (a.user ?? '') === (b.user ?? '')
    && (a.password ?? '') === (b.password ?? '');
}

async function liveAgentsReferencingHost(app: FastifyInstance, hostId: string): Promise<string[]> {
  const live: string[] = [];
  for (const project of app.ctx.config.project) {
    for (const pair of project.agent) {
      for (const agent of pair) {
        if (agent.host !== hostId) continue;
        if (await agentIsLive(app.ctx, agent.id)) {
          live.push(agent.id);
        }
      }
    }
  }
  const coordinator = app.ctx.rootRecoveryCoordinator;
  const rootStatus = coordinator?.getRuntimeControlStatus();
  const currentRootUsesHost = app.ctx.config.root?.mode === 'remote'
    && app.ctx.config.root.host === hostId;
  const legacyRootNeedsProtection = coordinator?.usesHost(hostId)
    && rootStatus !== 'stopped-until-restart';
  const rootProbeRequired = (currentRootUsesHost || legacyRootNeedsProtection)
    && (rootStatus !== 'stop-incomplete' || !coordinator?.canRepairHostAfterIncompleteStop());
  if (coordinator && rootProbeRequired) {
    try {
      if (await coordinator.isRuntimeLive()) live.push(ROOT_AGENT_ID);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[hosts] root-agent liveness probe failed for host ${hostId}: ${detail}`);
      throw new HostLivenessUnknownError(hostId, detail);
    }
  }
  return live;
}

class HostLivenessUnknownError extends Error {
  constructor(readonly hostId: string, detail: string) {
    super(
      `无法确认 host "${hostId}" 上 root-agent 的运行状态：${detail}。` +
      '请恢复旧 host 连接，或先停用 root agent 后重试',
    );
    this.name = 'HostLivenessUnknownError';
  }
}

function hostBodyError(body: HostBody, hostnameRequired: boolean): string | null {
  if (hostnameRequired || body.hostname !== undefined) {
    if (typeof body.hostname !== 'string' || !body.hostname.trim()) return 'hostname is required';
  }
  if (body.port !== undefined && body.port !== null
    && (!Number.isInteger(body.port) || body.port <= 0 || body.port > 65535)) {
    return 'port must be a positive integer ≤ 65535';
  }
  for (const field of ['alias', 'user', 'password'] as const) {
    if (body[field] !== undefined && typeof body[field] !== 'string') {
      return `${field} must be a string`;
    }
  }
  return null;
}

function applyHostPatch(base: HostConfig, body: HostBody): HostConfig {
  const password = resolvePassword(body.password, base.password);
  const alias = body.alias?.trim() ?? base.alias;
  const user = body.user?.trim() ?? base.user;
  const port = body.port === null ? undefined : (body.port ?? base.port);
  return {
    id: base.id,
    hostname: body.hostname?.trim() ?? base.hostname,
    ...(port !== undefined ? { port } : {}),
    ...(alias ? { alias } : {}),
    ...(user ? { user } : {}),
    ...(password ? { password } : {}),
  };
}

async function invalidateStreamersForHost(app: FastifyInstance, hostId: string): Promise<void> {
  const mgr = app.ctx.paneStreamerManager;
  if (mgr) {
    for (const project of app.ctx.config.project) {
      for (const pair of project.agent) {
        for (const agent of pair) {
          if (agent.host === hostId && mgr.has(agent.id)) {
            await mgr.destroy(agent.id);
          }
        }
      }
    }
  }
  if (app.ctx.rootRecoveryCoordinator?.usesHost(hostId)) {
    await app.ctx.rootRecoveryCoordinator.invalidateRuntimeStreamer();
  }
}

function buildHostFromBody(body: HostBody, id: string, password: string | undefined): HostConfig {
  return {
    id,
    hostname: body.hostname!.trim(),
    ...(body.port != null ? { port: body.port } : {}),
    ...(body.alias?.trim() ? { alias: body.alias.trim() } : {}),
    ...(body.user?.trim() ? { user: body.user.trim() } : {}),
    ...(password ? { password } : {}),
  };
}

async function persistHosts(app: FastifyInstance, hosts: HostConfig[]): Promise<BaxianConfig> {
  const merged: BaxianConfig = { ...app.ctx.config, host: hosts };
  const validated = prepareConfig(merged);
  const hotReload = await prepareConfigHotReload(app.ctx, validated);
  await saveConfig(app.ctx.configPath!, validated);
  app.ctx.config = validated;
  await applyConfigHotReload(app.ctx, validated, hotReload);
  return validated;
}

export async function hostRoutes(app: FastifyInstance, options: HostRoutesOptions = {}): Promise<void> {
  const makeLocal = options.localRunnerFactory ?? (() => new LocalRunner());

  app.get('/hosts', async () => redactHosts(app.ctx.config.host));

  app.post<{ Body: HostBody }>('/hosts', async (request, reply) => {
    if (!app.ctx.configPath) {
      return reply.status(500).send({ error: 'No config path configured' });
    }
    const body = (request.body ?? {}) as HostBody;
    const bodyError = hostBodyError(body, true);
    if (bodyError) {
      return reply.status(400).send({ error: bodyError });
    }

    const probe = buildHostFromBody(body, 'probe', body.password);
    const conn = await checkHostConnectivity(probe, makeLocal);
    if (!conn.ok) {
      return reply.status(400).send({ error: conn.message });
    }

    return withConfigLock(async () => {
      const existingIds = new Set(
        app.ctx.config.host.map(h => h.id).filter((id): id is string => typeof id === 'string'),
      );
      const id = generateHostId(body.alias || body.hostname!, existingIds);
      const host = buildHostFromBody(body, id, body.password);
      try {
        const validated = await persistHosts(app, [...app.ctx.config.host, host]);
        const stored = validated.host.find(h => h.id === id)!;
        return reply.status(201).send({ host: redactHosts([stored])[0], restartRequired: false });
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          return reply.status(400).send({ error: 'Invalid host', details: err.errors });
        }
        throw err;
      }
    });
  });

  app.patch<{ Params: { id: string }; Body: HostBody }>('/hosts/:id', async (request, reply) => {
    if (!app.ctx.configPath) {
      return reply.status(500).send({ error: 'No config path configured' });
    }
    const { id } = request.params;
    const body = (request.body ?? {}) as HostBody;
    const current = app.ctx.config.host.find(h => h.id === id);
    if (!current) {
      return reply.status(404).send({ error: `Host "${id}" not found` });
    }
    const bodyError = hostBodyError(body, false);
    if (bodyError) {
      return reply.status(400).send({ error: bodyError });
    }

    const endpointChanged = structuralChange(current, applyHostPatch(current, { ...body, password: undefined }));
    if (endpointChanged && current.password !== undefined
      && (body.password === undefined || body.password === REDACTED)) {
      return reply.status(400).send({
        error: '修改 host 地址 / 端口 / 用户名时必须重新填写密码（或清空密码改用 key 登录）',
      });
    }

    const probeHost = applyHostPatch(current, body);
    if (structuralChange(current, probeHost)) {
      let live: string[];
      try {
        live = await liveAgentsReferencingHost(app, id);
      } catch (err) {
        if (err instanceof HostLivenessUnknownError) {
          return reply.status(503).send({ error: err.message });
        }
        throw err;
      }
      if (live.length > 0) {
        return reply.status(409).send({
          error:
            `host "${id}" 正被运行中的 agent ${live.join(', ')} 引用，` +
            '请先停止其会话再修改地址 / 端口 / 用户',
        });
      }
    }

    const conn = await checkHostConnectivity(probeHost, makeLocal);
    if (!conn.ok) {
      return reply.status(400).send({ error: conn.message });
    }

    return withConfigLock(async () => {
      const idx = app.ctx.config.host.findIndex(h => h.id === id);
      if (idx === -1) {
        return reply.status(404).send({ error: `Host "${id}" not found` });
      }
      const lockedCurrent = app.ctx.config.host[idx];
      const next = applyHostPatch(lockedCurrent, body);
      if (structuralChange(lockedCurrent, next)) {
        let live: string[];
        try {
          live = await liveAgentsReferencingHost(app, id);
        } catch (err) {
          if (err instanceof HostLivenessUnknownError) {
            return reply.status(503).send({ error: err.message });
          }
          throw err;
        }
        if (live.length > 0) {
          return reply.status(409).send({
            error:
              `host "${id}" 正被运行中的 agent ${live.join(', ')} 引用，` +
              '请先停止其会话再修改地址 / 端口 / 用户',
          });
        }
      }
      if (!sameConnection(next, probeHost)) {
        const reConn = await checkHostConnectivity(next, makeLocal);
        if (!reConn.ok) {
          return reply.status(400).send({ error: reConn.message });
        }
      }
      const hosts = app.ctx.config.host.slice();
      hosts[idx] = next;
      const connectionChanged = !sameConnection(lockedCurrent, next);
      try {
        const validated = await persistHosts(app, hosts);
        if (connectionChanged) await invalidateStreamersForHost(app, id);
        const stored = validated.host.find(h => h.id === id)!;
        return reply.send({ host: redactHosts([stored])[0], restartRequired: false });
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          return reply.status(400).send({ error: 'Invalid host', details: err.errors });
        }
        throw err;
      }
    });
  });

  app.delete<{ Params: { id: string } }>('/hosts/:id', async (request, reply) => {
    if (!app.ctx.configPath) {
      return reply.status(500).send({ error: 'No config path configured' });
    }
    const { id } = request.params;
    return withConfigLock(async () => {
      const current = app.ctx.config.host.find(h => h.id === id);
      if (!current) {
        return reply.status(404).send({ error: `Host "${id}" not found` });
      }
      const referencing: string[] = [];
      for (const project of app.ctx.config.project) {
        for (const pair of project.agent) {
          for (const agent of pair) {
            if (agent.host === id) referencing.push(agent.id);
          }
        }
      }
      const coordinator = app.ctx.rootRecoveryCoordinator;
      if ((app.ctx.config.root?.mode === 'remote' && app.ctx.config.root.host === id)
        || (coordinator?.usesHost(id) && !coordinator.isRuntimeExplicitlyStopped())) {
        referencing.push(ROOT_AGENT_ID);
      }
      if (referencing.length > 0) {
        return reply.status(409).send({
          error: `host "${id}" 仍被 agent ${referencing.join(', ')} 引用，请先改用其他 host 或删除这些 agent`,
        });
      }
      await persistHosts(app, app.ctx.config.host.filter(h => h.id !== id));
      return reply.send({ removed: id, restartRequired: false });
    });
  });

  app.post<{ Body: HostBody }>('/hosts/check', async (request, reply) => {
    const body = (request.body ?? {}) as HostBody;
    const bodyError = hostBodyError(body, true);
    if (bodyError) {
      return reply.status(400).send({ error: bodyError });
    }
    const stored = body.id ? app.ctx.config.host.find(h => h.id === body.id) : undefined;
    const submitted = buildHostFromBody(body, body.id ?? 'check', undefined);
    const reuseStored = !!stored && !structuralChange(stored, submitted);
    const password = (body.password === undefined || body.password === REDACTED)
      ? (reuseStored ? stored!.password : undefined)
      : body.password;
    const host = buildHostFromBody(body, body.id ?? 'check', password);
    const conn = await checkHostConnectivity(host, makeLocal);
    return reply.send(conn);
  });
}
