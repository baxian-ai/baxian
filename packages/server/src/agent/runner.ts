import { spawn } from 'node:child_process';
import { mkdir, writeFile as fsWriteFile, chmod } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import type { AgentMode, HostConfig } from '../shared/index.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RemoteShellMode = 'login' | 'login-interactive';

export interface ExecOptions {
  timeout?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
  remoteShell?: RemoteShellMode;
  stdin?: Buffer;
  env?: Record<string, string>;
}

export interface CommandRunner {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  writeFile(path: string, content: Buffer | string): Promise<void>;
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

    const child = spawn('/bin/bash', ['-c', command], {
      detached: true,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    if (options.stdin) {
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

const SSH_MUX_DIR = join(homedir(), '.baxian', 'ssh-mux');
const SSH_CONTROL_PERSIST = '5m';

let muxDirReady: Promise<void> | undefined;
export function ensureMuxDir(): Promise<void> {
  if (!muxDirReady) {
    muxDirReady = mkdir(SSH_MUX_DIR, { recursive: true, mode: 0o700 })
      .then(() => undefined)
      .catch(err => {
        console.warn(`[runner] ensureMuxDir(${SSH_MUX_DIR}) failed; SSH will run without mux this call:`, err);
        muxDirReady = undefined;
      });
  }
  return muxDirReady;
}

export function __resetMuxDirReadyForTests(): void {
  muxDirReady = undefined;
}

const SSH_ASKPASS_PATH = join(homedir(), '.baxian', 'ssh-askpass');
const SSH_ASKPASS_SCRIPT = '#!/bin/sh\nprintf \'%s\\n\' "$BAXIAN_SSH_PASSWORD"\n';
let askpassReady: Promise<string> | undefined;
function ensureAskpassHelper(): Promise<string> {
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

export function resolveAgentHost(
  hosts: HostConfig[] | undefined,
  ref: string | HostConfig | undefined,
): HostConfig | undefined {
  if (ref === undefined) return undefined;
  const host: unknown = typeof ref === 'string'
    ? (hosts ?? []).find(h => h.id === ref)
    : ref;
  return isUsableHostConfig(host) ? host : undefined;
}

export function hostGroupKey(mode: AgentMode, host: HostConfig | undefined): string {
  if (mode === 'local') return 'local';
  if (!isUsableHostConfig(host)) return 'remote:';
  const port = host.port === undefined ? 'default' : host.port;
  return host.user
    ? `remote:${host.user}@${host.hostname}:${port}`
    : `remote:${host.hostname}:${port}`;
}

export function workdirHostGroupKey(mode: AgentMode, host: HostConfig | undefined): string {
  if (mode !== 'remote' || !isUsableHostConfig(host)) return hostGroupKey(mode, host);
  return hostGroupKey(mode, {
    ...host,
    hostname: host.hostname.toLowerCase(),
    ...(host.port === undefined ? { port: 22 } : {}),
  });
}

export function mayShareHostAccount(
  leftMode: AgentMode,
  leftHost: HostConfig | undefined,
  rightMode: AgentMode,
  rightHost: HostConfig | undefined,
): boolean {
  if (leftMode === 'local' || rightMode === 'local') {
    if (leftMode === 'local' && rightMode === 'local') return true;
    const remoteHost = leftMode === 'remote' ? leftHost : rightHost;
    if (!isUsableHostConfig(remoteHost)) return true;
    if (!isLoopbackSshHost(remoteHost)) return false;
    if (remoteHost.user === undefined) return true;
    const username = currentUsername();
    return username === undefined || remoteHost.user === username;
  }
  if (!isUsableHostConfig(leftHost) || !isUsableHostConfig(rightHost)) return true;
  if (sshHostKey(leftHost) !== sshHostKey(rightHost)) return false;
  if (leftHost.user !== undefined && rightHost.user !== undefined) {
    return leftHost.user === rightHost.user;
  }
  return true;
}

function sshHostKey(host: HostConfig): string {
  const normalized = normalizeSshHostname(host.hostname);
  const loopback = isLoopbackHostname(normalized);
  return JSON.stringify([
    loopback ? 'loopback' : 'hostname',
    loopback ? '' : normalized,
  ]);
}

function normalizeSshHostname(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  try {
    const input = normalized.includes(':') ? `[${normalized}]` : normalized;
    return new URL(`http://${input}/`).hostname.replace(/^\[(.*)\]$/, '$1');
  } catch {
    return normalized;
  }
}

function isLoopbackSshHost(host: HostConfig): boolean {
  return isLoopbackHostname(normalizeSshHostname(host.hostname));
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  const address = hostname.replace(/%.+$/, '');
  const family = isIP(address);
  if (family === 4) return hostname.split('.')[0] === '127';
  if (family !== 6) return false;
  const canonical = canonicalIpv6(address);
  if (canonical === '::1') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  return mapped !== null && (Number.parseInt(mapped[1]!, 16) >>> 8) === 127;
}

function canonicalIpv6(address: string): string {
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.slice(1, -1);
  } catch {
    return address;
  }
}

function currentUsername(): string | undefined {
  try {
    const username = userInfo().username;
    return username.trim() === '' ? undefined : username;
  } catch {
    return undefined;
  }
}

function isUsableHostConfig(value: unknown): value is HostConfig {
  if (typeof value !== 'object' || value === null) return false;
  const host = value as { hostname?: unknown; port?: unknown; user?: unknown };
  return typeof host.hostname === 'string'
    && host.hostname.trim() !== ''
    && (host.port === undefined
      || (typeof host.port === 'number'
        && Number.isInteger(host.port)
        && host.port > 0
        && host.port <= 65_535))
    && (host.user === undefined || typeof host.user === 'string');
}

export function sshTarget(host: HostConfig): string {
  return host.user ? `${host.user}@${host.hostname}` : host.hostname;
}

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

const activeMuxTargets = new Map<string, { target: string; port: number | undefined }>();

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
    }
  }));
}

export function __resetMuxTargetsForTests(): void {
  activeMuxTargets.clear();
}

export interface BuildSshOptionsArgs {
  connectTimeoutSec?: number;
  noMux?: boolean;
}

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

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const remoteCmd = `mkdir -p ${shellQuote(dirname(filePath))} && cat > ${shellQuote(filePath)}`;
    const r = await this.execRawRemoteWithStdin(remoteCmd, buf);
    if (r.exitCode !== 0) {
      throw new Error(`writeFile remote failed (${filePath}): ${r.stderr}`);
    }
  }

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
