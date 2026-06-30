import type { FastifyInstance } from 'fastify';
import type { AgentMode, HostConfig } from '../shared/index.js';
import type { CommandRunner, RemoteShellMode } from '../agent/runner.js';
import { createRunner, LocalRunner, buildSshOptions, ensureMuxDir, shellQuote, sshTarget, sshEnv } from '../agent/runner.js';

interface ProbeRequest {
  mode: AgentMode;
  host?: { hostname?: string; user?: string; port?: number };
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
    const result = await runner.exec(`which ${binary}`, {
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

export interface ProbeRoutesOptions {
  localRunnerFactory?: () => CommandRunner;
  remoteRunnerFactory?: (host: HostConfig) => CommandRunner;
}

export async function probeRoutes(app: FastifyInstance, options: ProbeRoutesOptions = {}): Promise<void> {
  const makeLocal = options.localRunnerFactory ?? (() => new LocalRunner());
  const makeRemote = options.remoteRunnerFactory ?? ((h: HostConfig) => createRunner('remote', h));

  app.post<{ Body: ProbeRequest }>('/agents/probe', async (request, reply) => {
    const { mode, host: inlineHost, hostId } = (request.body ?? {}) as ProbeRequest;

    if (mode !== 'local' && mode !== 'remote') {
      return reply.status(400).send({ error: 'mode must be "local" or "remote"' });
    }

    let host: HostConfig | undefined;
    if (mode === 'remote') {
      if (hostId) {
        host = app.ctx.config.host.find(h => h.id === hostId);
        if (!host) {
          return reply.status(400).send({ error: `unknown host id "${hostId}"` });
        }
      } else if (typeof inlineHost?.hostname === 'string' && inlineHost.hostname.trim()) {
        const port = inlineHost.port;
        if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
          return reply.status(400).send({ error: 'host.port must be a positive integer ≤ 65535' });
        }
        host = {
          hostname: inlineHost.hostname,
          ...(inlineHost.user ? { user: inlineHost.user } : {}),
          ...(port !== undefined ? { port } : {}),
        };
      } else {
        return reply.status(400).send({ error: 'host.hostname or hostId required for remote mode' });
      }
    }

    const result: ProbeResponse = {
      tmux: { ok: false, message: '' },
      runtimes: {
        'claude-code': { ok: false, message: '' },
        codex: { ok: false, message: '' },
      },
    };

    if (mode === 'remote') {
      const target = sshTarget(host!);
      await ensureMuxDir();
      const sshCmd = `ssh ${buildSshOptions(host!, { connectTimeoutSec: 5, noMux: true })} -- ${shellQuote(target)} echo ok`;
      const env = await sshEnv(host!);
      const sshResult = await makeLocal()
        .exec(sshCmd, { timeout: PROBE_TIMEOUT_MS, ...(Object.keys(env).length ? { env } : {}) })
        .catch((err) => ({
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        }));
      const sshOk = sshResult.exitCode === 0 && sshResult.stdout.includes('ok');
      result.ssh = {
        ok: sshOk,
        message: sshOk ? 'SSH OK' : 'SSH 不通，请检查地址 / 端口 / 密码或 key 认证',
      };
      if (!sshOk) {
        result.tmux = { ok: false, message: 'SSH 不通，无法探测' };
        result.runtimes['claude-code'] = { ok: false, message: 'SSH 不通，无法探测' };
        result.runtimes['codex'] = { ok: false, message: 'SSH 不通，无法探测' };
        return reply.send(result);
      }
    }

    const runner = mode === 'remote' ? makeRemote(host as HostConfig) : makeLocal();
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
}
