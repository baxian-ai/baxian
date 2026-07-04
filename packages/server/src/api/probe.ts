import type { FastifyInstance } from 'fastify';
import type { AgentMode, HostConfig } from '../shared/index.js';
import type { CommandRunner, RemoteShellMode } from '../agent/runner.js';
import { createRunner, LocalRunner, buildSshOptions, ensureMuxDir, shellQuote, sshTarget, sshEnv } from '../agent/runner.js';
import { installTmux, type TmuxInstallResult } from '../agent/tmux-install.js';

interface ProbeRequest {
  mode: AgentMode;
  host?: { hostname?: string; user?: string; port?: number; password?: string };
  hostId?: string;
}

interface ProbeStatus {
  ok: boolean;
  path?: string;
  message: string;
}

interface ProbeResponse {
  ssh?: { ok: boolean; message: string };
  tmux: ProbeStatus;
  runtimes: {
    'claude-code': ProbeStatus;
    'codex': ProbeStatus;
  };
}

export interface InstallTmuxResponse extends TmuxInstallResult {
  tmux: ProbeStatus;
}

const PROBE_TIMEOUT_MS = 5000;

interface ProbeRunner {
  exec: (
    cmd: string,
    opts?: { timeout?: number; remoteShell?: RemoteShellMode },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function lastNonEmptyLine(s: string): string {
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return '';
}

async function probeWhich(
  runner: ProbeRunner,
  binary: string,
  installHint: string,
  mode: RemoteShellMode = 'login',
): Promise<ProbeStatus> {
  try {
    const result = await runner.exec(`command -v ${binary}`, {
      timeout: PROBE_TIMEOUT_MS,
      remoteShell: mode,
    });
    const path = lastNonEmptyLine(result.stdout);
    if (result.exitCode === 0 && path) {
      return { ok: true, path, message: `${binary} found` };
    }
    return { ok: false, message: installHint };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: /timed out/i.test(msg) ? `${binary} probe timed out` : `${binary} probe failed`,
    };
  }
}

type ResolvedTarget = { error: string } | { host?: HostConfig };

function resolveTargetHost(app: FastifyInstance, body: ProbeRequest): ResolvedTarget {
  const { mode, host: inlineHost, hostId } = body;
  if (mode !== 'local' && mode !== 'remote') {
    return { error: 'mode must be "local" or "remote"' };
  }
  if (mode === 'local') return {};
  if (hostId) {
    const host = app.ctx.config.host.find(h => h.id === hostId);
    if (!host) return { error: `unknown host id "${hostId}"` };
    return { host };
  }
  if (typeof inlineHost?.hostname === 'string' && inlineHost.hostname.trim()) {
    const port = inlineHost.port;
    if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
      return { error: 'host.port must be a positive integer ≤ 65535' };
    }
    if (inlineHost.password !== undefined && typeof inlineHost.password !== 'string') {
      return { error: 'host.password must be a string' };
    }
    return {
      host: {
        hostname: inlineHost.hostname,
        ...(inlineHost.user ? { user: inlineHost.user } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(inlineHost.password ? { password: inlineHost.password } : {}),
      },
    };
  }
  return { error: 'host.hostname or hostId required for remote mode' };
}

async function checkSsh(
  host: HostConfig,
  makeLocal: () => CommandRunner,
): Promise<{ ok: boolean; message: string }> {
  const target = sshTarget(host);
  await ensureMuxDir();
  const sshCmd = `ssh ${buildSshOptions(host, { connectTimeoutSec: 5, noMux: true })} -- ${shellQuote(target)} echo ok`;
  const env = await sshEnv(host);
  const result = await makeLocal()
    .exec(sshCmd, { timeout: PROBE_TIMEOUT_MS, ...(Object.keys(env).length ? { env } : {}) })
    .catch((err) => ({
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    }));
  const ok = result.exitCode === 0 && result.stdout.includes('ok');
  return { ok, message: ok ? 'SSH OK' : 'SSH 不通，请检查地址 / 端口 / 密码或 key 认证' };
}

function installKey(host: HostConfig | undefined): string {
  if (!host) return 'local';
  return `${host.user ?? ''}@${host.hostname}:${host.port ?? ''}`;
}

export interface ProbeRoutesOptions {
  localRunnerFactory?: () => CommandRunner;
  remoteRunnerFactory?: (host: HostConfig) => CommandRunner;
}

export async function probeRoutes(app: FastifyInstance, options: ProbeRoutesOptions = {}): Promise<void> {
  const makeLocal = options.localRunnerFactory ?? (() => new LocalRunner());
  const makeRemote = options.remoteRunnerFactory ?? ((h: HostConfig) => createRunner('remote', h));
  const inflightInstalls = new Map<string, Promise<InstallTmuxResponse>>();

  app.post<{ Body: ProbeRequest }>('/agents/probe', async (request, reply) => {
    const body = (request.body ?? {}) as ProbeRequest;
    const resolved = resolveTargetHost(app, body);
    if ('error' in resolved) {
      return reply.status(400).send({ error: resolved.error });
    }
    const host = resolved.host;

    const result: ProbeResponse = {
      tmux: { ok: false, message: '' },
      runtimes: {
        'claude-code': { ok: false, message: '' },
        codex: { ok: false, message: '' },
      },
    };

    if (body.mode === 'remote') {
      const ssh = await checkSsh(host!, makeLocal);
      result.ssh = ssh;
      if (!ssh.ok) {
        result.tmux = { ok: false, message: 'SSH 不通，无法探测' };
        result.runtimes['claude-code'] = { ok: false, message: 'SSH 不通，无法探测' };
        result.runtimes['codex'] = { ok: false, message: 'SSH 不通，无法探测' };
        return reply.send(result);
      }
    }

    const runner = body.mode === 'remote' ? makeRemote(host as HostConfig) : makeLocal();
    const [tmux, claude, codex] = await Promise.all([
      probeWhich(runner, 'tmux', '请安装 tmux'),
      probeWhich(runner, 'claude', '请先安装 Claude Code CLI', 'login-interactive'),
      probeWhich(runner, 'codex', '请先安装 Codex CLI', 'login-interactive'),
    ]);

    result.tmux = tmux;
    result.runtimes['claude-code'] = claude;
    result.runtimes['codex'] = codex;

    return reply.send(result);
  });

  app.post<{ Body: ProbeRequest }>('/agents/install-tmux', async (request, reply) => {
    const body = (request.body ?? {}) as ProbeRequest;
    const resolved = resolveTargetHost(app, body);
    if ('error' in resolved) {
      return reply.status(400).send({ error: resolved.error });
    }
    const host = resolved.host;

    if (body.mode === 'remote') {
      const ssh = await checkSsh(host!, makeLocal);
      if (!ssh.ok) {
        const response: InstallTmuxResponse = {
          ok: false,
          message: ssh.message,
          tmux: { ok: false, message: 'SSH 不通，无法探测' },
        };
        return reply.send(response);
      }
    }

    // 同一目标机器的并发安装合并为一次执行：重复点击 / 前端超时重试都只跑一个安装进程
    const key = installKey(host);
    let pending = inflightInstalls.get(key);
    if (!pending) {
      const runner = body.mode === 'remote' ? makeRemote(host as HostConfig) : makeLocal();
      pending = (async () => {
        const install = await installTmux(runner);
        const tmux = await probeWhich(runner, 'tmux', '请安装 tmux');
        return { ...install, tmux };
      })();
      inflightInstalls.set(key, pending);
      void pending.finally(() => inflightInstalls.delete(key)).catch(() => undefined);
    }
    return reply.send(await pending);
  });
}
