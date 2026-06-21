import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile as fsWriteFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentMode, HostConfig } from '../shared/index.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// login-interactive matches tmux pane PATH; login skips banners.
export type RemoteShellMode = 'login' | 'login-interactive';

export interface ExecOptions {
  timeout?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
  remoteShell?: RemoteShellMode;
  stdin?: Buffer;
  // Extra env merged over process.env for the spawned shell. Carries SSH_ASKPASS for password hosts.
  env?: Record<string, string>;
}

export interface CommandRunner {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  writeFile(path: string, content: Buffer | string): Promise<void>;
  /** stdin bypasses argv ARG_MAX (~1MB). */
  execWithStdin(command: string, stdin: Buffer, options?: ExecOptions): Promise<ExecResult>;
}

const KILL_GRACE_MS = 2000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export class LocalRunner implements CommandRunner {
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return runShell(command, options);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await fsWriteFile(filePath, content);
  }

  async execWithStdin(
    command: string,
    stdin: Buffer,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    return runShell(command, { ...options, stdin });
  }
}

function runShell(command: string, options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Command aborted'));
      return;
    }

    let timeoutHit = false;
    let aborted = false;
    let settled = false;
    let bufferExceeded = false;
    let bufferedBytes = 0;
    let stdout = '';
    let stderr = '';
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const maxBuffer = options.maxBuffer === undefined ? DEFAULT_MAX_BUFFER : options.maxBuffer;

    const internalAbort = new AbortController();
    const onUserAbort = () => {
      aborted = true;
      internalAbort.abort();
    };
    if (options.signal) {
      options.signal.addEventListener('abort', onUserAbort, { once: true });
    }

    // detached → process-group kill prevents orphaning ssh/git children.
    const child = spawn('/bin/bash', ['-c', command], {
      detached: true,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    if (options.stdin) {
      // EPIPE on child exit during write — convert to abort.
      child.stdin?.on('error', () => {
        bufferExceeded = false;
        internalAbort.abort();
      });
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }

    const killGroup = (sig: NodeJS.Signals) => {
      if (typeof child.pid !== 'number') return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // group already gone
      }
    };

    internalAbort.signal.addEventListener('abort', () => killGroup('SIGTERM'), { once: true });

    const timer = options.timeout
      ? setTimeout(() => {
          timeoutHit = true;
          internalAbort.abort();
          killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
          killTimer.unref();
        }, options.timeout)
      : null;
    timer?.unref();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal) options.signal.removeEventListener('abort', onUserAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const accumulate = (chunk: Buffer): string | null => {
      if (bufferExceeded) return null;
      if (maxBuffer > 0 && bufferedBytes + chunk.length > maxBuffer) {
        bufferExceeded = true;
        internalAbort.abort();
        return null;
      }
      bufferedBytes += chunk.length;
      return chunk.toString();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const piece = accumulate(chunk);
      if (piece !== null) stdout += piece;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const piece = accumulate(chunk);
      if (piece !== null) stderr += piece;
    });

    child.on('error', (err) => {
      finish(() => {
        if (bufferExceeded) return reject(new Error(`Command output exceeded maxBuffer (${maxBuffer} bytes)`));
        if (timeoutHit) return reject(new Error(`Command timed out after ${options.timeout}ms`));
        if (aborted) return reject(new Error('Command aborted'));
        reject(err);
      });
    });

    child.on('close', (code, signal) => {
      finish(() => {
        if (bufferExceeded) return reject(new Error(`Command output exceeded maxBuffer (${maxBuffer} bytes)`));
        if (timeoutHit) return reject(new Error(`Command timed out after ${options.timeout}ms`));
        if (aborted) return reject(new Error('Command aborted'));
        resolve({
          stdout,
          stderr,
          exitCode: code ?? (signal ? 128 : 1),
        });
      });
    });
  });
}

// OpenSSH ControlMaster lets a backlog of short commands share one TCP+SSH session per target,
// cutting per-call TCP handshake + key exchange (~tens-of-ms each on LAN, much more on WAN).
// Caveats this design accepts: socket lives under the local user's HOME (multi-user boxes get
// per-user mux pools), and a crashed master leaves a stale socket — ControlMaster=auto detects
// and falls back to a fresh connection in that case.
const SSH_MUX_DIR = join(homedir(), '.baxian', 'ssh-mux');
const SSH_CONTROL_PERSIST = '5m';

let muxDirReady: Promise<void> | undefined;
export function ensureMuxDir(): Promise<void> {
  if (!muxDirReady) {
    // Read-only HOME / permission glitches must not strand the whole SSH path:
    // ControlMaster=auto falls back to a fresh TCP connection when ControlPath is
    // unreachable. Log + reset the singleton so a transient failure can recover next call.
    muxDirReady = mkdir(SSH_MUX_DIR, { recursive: true, mode: 0o700 })
      .then(() => undefined)
      .catch(err => {
        console.warn(`[runner] ensureMuxDir(${SSH_MUX_DIR}) failed; SSH will run without mux this call:`, err);
        muxDirReady = undefined;
      });
  }
  return muxDirReady;
}

// Test-only: reset the singleton so each spec exercises the first-call path.
export function __resetMuxDirReadyForTests(): void {
  muxDirReady = undefined;
}

// Helper ssh invokes for the password: SSH_ASKPASS reads it from the child env (BAXIAN_SSH_PASSWORD),
// so the secret never lands in argv (the sshpass `ps`-leak) or logs. OpenSSH 8.4+ + REQUIRE=force.
const SSH_ASKPASS_PATH = join(homedir(), '.baxian', 'ssh-askpass');
const SSH_ASKPASS_SCRIPT = '#!/bin/sh\nprintf \'%s\\n\' "$BAXIAN_SSH_PASSWORD"\n';
let askpassReady: Promise<string> | undefined;
export function ensureAskpassHelper(): Promise<string> {
  if (!askpassReady) {
    askpassReady = (async () => {
      await mkdir(dirname(SSH_ASKPASS_PATH), { recursive: true });
      await fsWriteFile(SSH_ASKPASS_PATH, SSH_ASKPASS_SCRIPT, { mode: 0o700 });
      await chmod(SSH_ASKPASS_PATH, 0o700);
      return SSH_ASKPASS_PATH;
    })().catch(err => {
      askpassReady = undefined;
      throw err;
    });
  }
  return askpassReady;
}

// Test-only: reset the singleton so each spec exercises the first-call path.
export function __resetAskpassReadyForTests(): void {
  askpassReady = undefined;
}

// Resolve an agent's host reference (registry id) — or a legacy inline host object — to a HostConfig.
export function resolveAgentHost(
  hosts: HostConfig[] | undefined,
  ref: string | HostConfig | undefined,
): HostConfig | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === 'string') return (hosts ?? []).find(h => h.id === ref);
  return ref;
}

// Cache/grouping key shared by RepoStore + bootstrap so the same physical machine de-dups.
// "no explicit port" must NOT collapse to ":22": such a host honors ~/.ssh/config's Port
// (the SSH builders omit -p), so it may reach a different machine than an explicit-22 registry host.
export function hostGroupKey(mode: AgentMode, host: HostConfig | undefined): string {
  if (mode === 'local') return 'local';
  if (!host) return 'remote:';
  const port = host.port === undefined ? 'default' : host.port;
  return host.user
    ? `remote:${host.user}@${host.hostname}:${port}`
    : `remote:${host.hostname}:${port}`;
}

export function sshTarget(host: HostConfig): string {
  return host.user ? `${host.user}@${host.hostname}` : host.hostname;
}

// Env for the spawned ssh: password hosts get SSH_ASKPASS (force) so auth is non-interactive
// without exposing the secret in argv. Key hosts get nothing (rely on ~/.ssh / agent).
export async function sshEnv(host: HostConfig | undefined): Promise<Record<string, string>> {
  if (!host?.password) return {};
  const helper = await ensureAskpassHelper();
  return {
    SSH_ASKPASS: helper,
    SSH_ASKPASS_REQUIRE: 'force',
    BAXIAN_SSH_PASSWORD: host.password,
    DISPLAY: '',
  };
}

// Targets we've opened a ControlMaster mux to, so shutdown can converge them (keyed by target:port).
const activeMuxTargets = new Map<string, { target: string; port: number | undefined }>();

// Tell each persisted master to exit instead of lingering for ControlPersist (5m) past
// process death. Best-effort: a missing socket means the master already exited; a peer
// instance sharing HOME just reconnects via ControlMaster=auto.
export async function closeSshMux(local: CommandRunner = new LocalRunner()): Promise<void> {
  const targets = [...activeMuxTargets.values()];
  activeMuxTargets.clear();
  const controlPath = shellQuote(join(SSH_MUX_DIR, 'cm-%C'));
  await Promise.all(targets.map(async ({ target, port }) => {
    try {
      const portFlag = port !== undefined ? `-p ${port} ` : '';
      await local.exec(
        `ssh -o ControlPath=${controlPath} ${portFlag}-O exit -- ${shellQuote(target)}`,
        { timeout: 3000 },
      );
    } catch {
      // master already gone / socket missing — nothing to converge
    }
  }));
}

// Test-only: drop tracked targets between specs.
export function __resetMuxTargetsForTests(): void {
  activeMuxTargets.clear();
}

export interface BuildSshOptionsArgs {
  connectTimeoutSec?: number;
  // Force a fresh authenticated connection (no mux reuse) — connectivity checks need this so a
  // lingering authenticated master can't make a wrong updated password pass `ssh echo ok`.
  noMux?: boolean;
}

// Auth -o flags: key hosts fail fast (BatchMode); password hosts allow askpass (force) + auto-accept
// a new host key so the yes/no prompt doesn't get the password as its answer.
export function sshAuthArgs(host: HostConfig | undefined): string[] {
  if (host?.password) {
    return [
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'StrictHostKeyChecking=accept-new',
    ];
  }
  return ['-o', 'BatchMode=yes'];
}

// Canonical ssh option args (for spawn): -o pairs + -p port, host-aware (BatchMode vs askpass).
// -p is emitted ONLY when the host supplies a port; a host with no port (form left blank, or a
// legacy inline host) keeps honoring its ~/.ssh/config `Port`.
export function buildSshArgs(host: HostConfig | undefined, args: BuildSshOptionsArgs = {}): string[] {
  const connectTimeoutSec = args.connectTimeoutSec ?? 10;
  const out: string[] = [...sshAuthArgs(host)];
  out.push(
    '-o', `ConnectTimeout=${connectTimeoutSec}`,
    '-o', 'ServerAliveInterval=2',
    '-o', 'ServerAliveCountMax=2',
  );
  if (args.noMux) {
    out.push('-o', 'ControlMaster=no', '-o', 'ControlPath=none');
  } else {
    out.push(
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${join(SSH_MUX_DIR, 'cm-%C')}`,
      '-o', `ControlPersist=${SSH_CONTROL_PERSIST}`,
    );
  }
  if (host?.port !== undefined) out.push('-p', String(host.port));
  return out;
}

// String form for `bash -c` command lines. Only the ControlPath value is shell-quoted (a HOME with
// spaces must stay one argv); other -o values are metachar-free, kept bare to match the original format.
export function buildSshOptions(host: HostConfig | undefined, args: BuildSshOptionsArgs = {}): string {
  const connectTimeoutSec = args.connectTimeoutSec ?? 10;
  const parts: string[] = [sshAuthArgs(host).join(' ')];
  parts.push(
    `-o ConnectTimeout=${connectTimeoutSec}`,
    '-o ServerAliveInterval=2',
    '-o ServerAliveCountMax=2',
  );
  if (args.noMux) {
    parts.push('-o ControlMaster=no', '-o ControlPath=none');
  } else {
    parts.push(
      '-o ControlMaster=auto',
      `-o ControlPath=${shellQuote(join(SSH_MUX_DIR, 'cm-%C'))}`,
      `-o ControlPersist=${SSH_CONTROL_PERSIST}`,
    );
  }
  if (host?.port !== undefined) parts.push(`-p ${host.port}`);
  return parts.join(' ');
}

export class SshRunner implements CommandRunner {
  private local: CommandRunner;
  constructor(
    private host: HostConfig,
    local?: CommandRunner,
  ) {
    this.local = local ?? new LocalRunner();
  }

  private remoteTarget(): string {
    const target = sshTarget(this.host);
    const port = this.host.port;
    activeMuxTargets.set(`${target}:${port ?? 'default'}`, { target, port });
    return target;
  }

  private async withSshEnv(options: ExecOptions): Promise<ExecOptions> {
    const env = await sshEnv(this.host);
    if (Object.keys(env).length === 0) return options;
    return { ...options, env: { ...options.env, ...env } };
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    await ensureMuxDir();
    const target = this.remoteTarget();
    const wrapped = wrapRemoteCommand(command, options.remoteShell ?? 'login');
    const ssh = `ssh ${buildSshOptions(this.host)} -- ${shellQuote(target)} ${shellQuote(wrapped)}`;
    return this.local.exec(ssh, await this.withSshEnv(options));
  }

  // openssl avoids GNU/BSD base64 flag drift; payloads must stay below ARG_MAX.
  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const b64 = buf.toString('base64');
    const eof = `BAXIAN_EOF_${randomBytes(4).toString('hex')}`;
    // Run the heredoc under POSIX `sh`: wrapRemoteCommand hands this to the user's login shell
    // ($SHELL -l -c), and fish has no `<<EOF` heredocs — a fish login host would fail every write.
    const inner =
      `mkdir -p ${shellQuote(dirname(filePath))} && ` +
      `openssl base64 -d -A > ${shellQuote(filePath)} <<'${eof}'\n${b64}\n${eof}`;
    const r = await this.exec(`sh -c ${shellQuote(inner)}`);
    if (r.exitCode !== 0) {
      throw new Error(`writeFile remote failed (${filePath}): ${r.stderr}`);
    }
  }

  /** Login wrapper may consume stdin via rc — use execRawRemoteWithStdin for clean stdin. */
  async execWithStdin(
    command: string,
    stdin: Buffer,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    await ensureMuxDir();
    const target = this.remoteTarget();
    const wrapped = wrapRemoteCommand(command, options.remoteShell ?? 'login');
    const ssh = `ssh ${buildSshOptions(this.host)} -- ${shellQuote(target)} ${shellQuote(wrapped)}`;
    return this.local.execWithStdin(ssh, stdin, await this.withSshEnv(options));
  }

  /** No login wrapper — clean stdin for load-buffer; remote runs with non-login PATH. */
  async execRawRemoteWithStdin(
    remoteCommand: string,
    stdin: Buffer,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    await ensureMuxDir();
    const target = this.remoteTarget();
    const ssh = `ssh ${buildSshOptions(this.host)} -- ${shellQuote(target)} ${shellQuote(remoteCommand)}`;
    return this.local.execWithStdin(ssh, stdin, await this.withSshEnv(options));
  }
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// sh as outer shell so fish accepts the $SHELL handoff.
export function wrapRemoteCommand(command: string, mode: RemoteShellMode = 'login'): string {
  const flags = mode === 'login-interactive' ? '-l -i -c' : '-l -c';
  const inner = `exec "\${SHELL:-/bin/sh}" ${flags} "$1"`;
  return `sh -c ${shellQuote(inner)} _ ${shellQuote(command)}`;
}

export function createRunner(mode: 'local' | 'remote', host?: HostConfig): CommandRunner {
  if (mode === 'remote') {
    if (!host) throw new Error('Remote mode requires host config');
    return new SshRunner(host);
  }
  return new LocalRunner();
}
