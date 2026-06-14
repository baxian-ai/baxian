import type { FastifyInstance } from 'fastify';
import type { HostConfig, BaxianConfig } from '../shared/index.js';
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
import { applyConfigHotReload } from '../config/hot-reload.js';
import { redactHosts } from './config.js';

const REDACTED = '***';
const CHECK_TIMEOUT_MS = 5000;

interface HostBody {
  id?: string;
  hostname?: string;
  // null = explicit clear (drop the port so ssh honors ~/.ssh/config); undefined = keep current.
  port?: number | null;
  alias?: string;
  user?: string;
  password?: string;
}

export interface HostRoutesOptions {
  // Tests inject this to avoid spawning real ssh against the host machine.
  localRunnerFactory?: () => CommandRunner;
}

// SSH reachability, forced through a FRESH authenticated connection (noMux) so a lingering mux
// can't make a wrong updated password pass — the bad password would then be saved.
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

// REDACTED / missing password both mean "keep the stored one" (mirrors server.token handling).
function resolvePassword(incoming: string | undefined, current: string | undefined): string | undefined {
  if (incoming === REDACTED || incoming === undefined) return current;
  return incoming;
}

// A missing port (honors ~/.ssh/config's Port) and an explicit 22 are DIFFERENT endpoints — collapsing
// them with `?? 22` would let a port:22 edit slip past the password-exfiltration / live-agent guards.
function structuralChange(prev: HostConfig, next: HostConfig): boolean {
  return prev.hostname !== next.hostname
    || (prev.user ?? '') !== (next.user ?? '')
    || prev.port !== next.port;
}

// Whether two hosts would dial the same SSH connection (so a re-probe is unnecessary).
function sameConnection(a: HostConfig, b: HostConfig): boolean {
  return a.hostname === b.hostname
    && a.port === b.port
    && (a.user ?? '') === (b.user ?? '')
    && (a.password ?? '') === (b.password ?? '');
}

// Agents whose host reference resolves to this id AND that currently occupy the machine: bound to an
// active task / mid-bootstrap (creationToken) / awaiting_human, or with a live pane / present tmux
// session. Moving the host's endpoint under them would orphan those sessions.
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
  return live;
}

// These routes have no Fastify schema, so raw JSON reaches the handlers untyped: a truthy non-string
// hostname (e.g. 123) would throw on .trim(), and a string/array port would inject into the ssh command.
// Validate types here so malformed host-management requests return 400, never a 500.
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

// Apply a PATCH body onto a base host: provided fields win, omitted fields inherit base, an explicit
// empty alias/user/password (or port: null) clears. Re-applied against the FRESH host inside the lock
// so concurrent edits to other fields aren't clobbered by a stale full-host replacement.
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

// Tear down live web terminal streamers of agents referencing this host so their cached host-derived
// runner/tmux (attach PTY, resize, session probe) are rebuilt with the new credential on reconnect.
// NOT silent: a silent destroy would skip onSessionGone, leaving open /api/stream sockets believing
// they're still subscribed to a now-deleted streamer (input silently dropped). The normal teardown
// fires session_gone so clients release and reconnect, which rebuilds the streamer with the new host.
function invalidateStreamersForHost(app: FastifyInstance, hostId: string): void {
  const mgr = app.ctx.paneStreamerManager;
  if (!mgr) return;
  for (const project of app.ctx.config.project) {
    for (const pair of project.agent) {
      for (const agent of pair) {
        if (agent.host === hostId && mgr.has(agent.id)) {
          void mgr.destroy(agent.id).catch(() => undefined);
        }
      }
    }
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
  await saveConfig(app.ctx.configPath!, validated);
  app.ctx.config = validated;
  applyConfigHotReload(app.ctx, validated);
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

    // SECURITY: changing the endpoint (hostname/user/port) of a password host requires an explicit
    // password (a new one, or '' to clear). Otherwise the stored secret — which the caller can't read,
    // it's redacted — would be sent to the newly supplied SSH target during the probe (exfiltration).
    const endpointChanged = structuralChange(current, applyHostPatch(current, { ...body, password: undefined }));
    if (endpointChanged && current.password !== undefined
      && (body.password === undefined || body.password === REDACTED)) {
      return reply.status(400).send({
        error: '修改 host 地址 / 端口 / 用户名时必须重新填写密码（或清空密码改用 key 登录）',
      });
    }

    // Probe the host the request describes (submitted fields over the current snapshot).
    const probeHost = applyHostPatch(current, body);
    if (structuralChange(current, probeHost)) {
      const live = await liveAgentsReferencingHost(app, id);
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

    // A request that sets or clears the password invalidates live streamers (below) so they rebuild
    // with the new credential; '***' / omitted means "keep", so no invalidation.
    const passwordChanged = body.password !== undefined && body.password !== REDACTED;

    return withConfigLock(async () => {
      const idx = app.ctx.config.host.findIndex(h => h.id === id);
      if (idx === -1) {
        return reply.status(404).send({ error: `Host "${id}" not found` });
      }
      // Rebase the patch onto the FRESH host inside the lock so a concurrent edit to other fields
      // (saved during our connectivity probe) isn't clobbered by a stale full-host replacement.
      const lockedCurrent = app.ctx.config.host[idx];
      const next = applyHostPatch(lockedCurrent, body);
      // Re-check liveness: an agent may have gone live during the (lock-free) probe.
      if (structuralChange(lockedCurrent, next)) {
        const live = await liveAgentsReferencingHost(app, id);
        if (live.length > 0) {
          return reply.status(409).send({
            error:
              `host "${id}" 正被运行中的 agent ${live.join(', ')} 引用，` +
              '请先停止其会话再修改地址 / 端口 / 用户',
          });
        }
      }
      // If a concurrent edit changed the connection fields, the rebased combination was never probed
      // (e.g. A's new hostname + B's new password). Never save an unverified host — re-check it here.
      if (!sameConnection(next, probeHost)) {
        const reConn = await checkHostConnectivity(next, makeLocal);
        if (!reConn.ok) {
          return reply.status(400).send({ error: reConn.message });
        }
      }
      const hosts = app.ctx.config.host.slice();
      hosts[idx] = next;
      try {
        const validated = await persistHosts(app, hosts);
        // A live web terminal streamer caches its host-derived runner/tmux; tear down referencing
        // streamers on a credential change so the next reconnect rebuilds with the new password.
        if (passwordChanged) invalidateStreamersForHost(app, id);
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
    // SECURITY: the stored password may only be reused to probe the SAME endpoint it belongs to.
    // Reusing it for a caller-chosen hostname/user/port would let an editor who can't read the
    // redacted secret exfiltrate it to a controlled SSH server. A changed endpoint must carry an
    // explicit password (else we probe key-auth only).
    const reuseStored = !!stored && !structuralChange(stored, submitted);
    const password = (body.password === undefined || body.password === REDACTED)
      ? (reuseStored ? stored!.password : undefined)
      : body.password;
    const host = buildHostFromBody(body, body.id ?? 'check', password);
    const conn = await checkHostConnectivity(host, makeLocal);
    return reply.send(conn);
  });
}
