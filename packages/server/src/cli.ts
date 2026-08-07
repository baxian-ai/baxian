#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { type HostConfig } from './shared/index.js';
import { startServer } from './index.js';
import { resolveHome } from './config/loader.js';
import { BUILTIN_PLATFORMS } from './platform/driver-host.js';
import {
  installPlatformPlugin,
  platformPluginStatuses,
  uninstallPlatformPlugin,
} from './platform/plugin-loader.js';
import { shellQuote, wrapRemoteCommand, sshTarget, resolveAgentHost } from './agent/runner.js';

export interface TtyDimensions {
  cols: number;
  rows: number;
}

export interface AttachCommand {
  kind: 'configure' | 'attach';
  file: string;
  args: string[];
}

export function readTtyDimensions(stdout: { columns?: number; rows?: number }): TtyDimensions | null {
  const cols = stdout.columns;
  const rows = stdout.rows;
  if (typeof cols !== 'number' || typeof rows !== 'number' || cols <= 0 || rows <= 0) {
    return null;
  }
  return { cols, rows };
}

function claimGatedWindowSize(agentId: string): string {
  const cond = `#{==:#{@baxian-agent-id},${agentId}}`;
  const set = `set-option -t '=${agentId}:' window-size latest`;
  return `tmux if-shell -t '=${agentId}:' -F '${cond}' '${set}' ''`;
}

export function buildLocalAttachCommands(
  agentId: string,
  _dims: TtyDimensions | null,
): AttachCommand[] {
  const cond = `#{==:#{@baxian-agent-id},${agentId}}`;
  return [
    {
      kind: 'configure',
      file: 'tmux',
      args: ['if-shell', '-t', `=${agentId}:`, '-F', cond, `set-option -t '=${agentId}:' window-size latest`, ''],
    },
    {
      kind: 'configure',
      file: 'tmux',
      args: ['set-option', '-g', 'focus-events', 'on'],
    },
    {
      kind: 'attach',
      file: 'tmux',
      args: ['-u', 'attach-session', '-t', `=${agentId}`],
    },
  ];
}

export function buildRemoteAttachSshArgs(
  host: HostConfig,
  agentId: string,
  _dims: TtyDimensions | null,
): string[] {
  const quotedId = shellQuote(`=${agentId}`);
  const autoSizePrefix = `${claimGatedWindowSize(agentId)} 2>/dev/null || true; `;
  const focusEventsPrefix = 'tmux set-option -g focus-events on 2>/dev/null || true; ';
  const attach = `tmux -u attach-session -t ${quotedId}`;
  return [
    '-o', 'ConnectTimeout=10',
    ...(host.port !== undefined ? ['-p', String(host.port)] : []),
    '-t',
    '--',
    sshTarget(host),
    wrapRemoteCommand(
      `${autoSizePrefix}${focusEventsPrefix}${attach}`,
      'login-interactive',
    ),
  ];
}

function resolveApiBase(opts: { apiUrl?: string }): string {
  if (opts.apiUrl) return opts.apiUrl.replace(/\/$/, '') + '/api';
  if (process.env.BAXIAN_API_URL) return process.env.BAXIAN_API_URL.replace(/\/$/, '') + '/api';
  const port = process.env.BAXIAN_PORT ?? '3000';
  return `http://127.0.0.1:${port}/api`;
}

function authHeaders(opts: { token?: string }): Record<string, string> {
  const token = opts.token ?? process.env.BAXIAN_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readResponse<T = unknown>(res: Response, method: string, path: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed (${res.status}): ${apiErrorDetail(text, res.statusText)}`);
  }
  const text = await res.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function apiErrorDetail(text: string, fallback: string): string {
  if (!text) return fallback;
  try {
    const body = JSON.parse(text) as unknown;
    if (
      typeof body === 'object'
      && body !== null
      && 'error' in body
      && typeof body.error === 'string'
    ) return body.error;
  } catch {
    return text;
  }
  return text;
}

async function apiGet<T = unknown>(path: string, opts: { apiUrl?: string; token?: string } = {}): Promise<T> {
  const res = await fetch(`${resolveApiBase(opts)}${path}`, {
    headers: authHeaders(opts),
  });
  return readResponse<T>(res, 'GET', path);
}

async function apiPost<T = unknown>(
  path: string,
  body?: unknown,
  opts: { apiUrl?: string; token?: string } = {},
): Promise<T> {
  const res = await fetch(`${resolveApiBase(opts)}${path}`, {
    method: 'POST',
    headers: body
      ? { 'Content-Type': 'application/json', ...authHeaders(opts) }
      : authHeaders(opts),
    body: body ? JSON.stringify(body) : undefined,
  });
  return readResponse<T>(res, 'POST', path);
}

async function apiPatch<T = unknown>(
  path: string,
  body?: unknown,
  opts: { apiUrl?: string; token?: string } = {},
): Promise<T> {
  const res = await fetch(`${resolveApiBase(opts)}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(opts) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return readResponse<T>(res, 'PATCH', path);
}

async function apiDelete<T = unknown>(
  path: string,
  opts: { apiUrl?: string; token?: string } = {},
): Promise<T | null> {
  const res = await fetch(`${resolveApiBase(opts)}${path}`, {
    method: 'DELETE',
    headers: authHeaders(opts),
  });
  if (res.status === 204) return null;
  return readResponse<T>(res, 'DELETE', path);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function withErrors(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export function readPackageVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

const HOME_OPTION = ['--home <dir>', 'Instance home directory (default ~/.baxian or BAXIAN_HOME)'] as const;

export function buildCli(): Command {
  const program = new Command();

  program
    .name('baxian')
    .description('AI agent orchestration')
    .version(readPackageVersion())
    .option('--api-url <url>', 'Override server URL (default http://127.0.0.1:3000 or BAXIAN_API_URL)')
    .option('--token <token>', 'Bearer token (default BAXIAN_TOKEN)');

  const ctxOf = (cmdOpts: { apiUrl?: string; token?: string }) => ({
    apiUrl: cmdOpts.apiUrl ?? program.opts().apiUrl,
    token: cmdOpts.token ?? program.opts().token,
  });

  program
    .command('start', { isDefault: true })
    .description('Start the baxian server (default command)')
    .option(...HOME_OPTION)
    .action(async (opts) => {
      await startServer(opts.home);
    });

  program
    .command('status')
    .description('Show status of all agents')
    .action(async (opts) => {
      const agents = await apiGet<Array<{
        id: string;
        runtimeStatus: string;
        tmuxSessionStatus: string;
        projectId?: string;
      }>>('/agents', ctxOf(opts));
      if (!Array.isArray(agents) || agents.length === 0) {
        console.log('No agents running.');
        return;
      }
      console.log('ID\t\tRUNTIME\t\tTMUX\t\tPROJECT');
      console.log('---\t\t-------\t\t----\t\t-------');
      for (const agent of agents) {
        console.log(`${agent.id}\t\t${agent.runtimeStatus}\t\t${agent.tmuxSessionStatus}\t\t${agent.projectId ?? '-'}`);
      }
    });

  program
    .command('attach <agent-id>')
    .description('Attach to agent tmux session (local or remote)')
    .action(async (agentId, opts) => {
      const ctx = ctxOf(opts);
      let agent: { mode: 'local' | 'remote'; host?: string } | undefined;
      let resolvedHost: HostConfig | undefined;
      try {
        type CfgAgent = { id: string; mode: 'local' | 'remote'; host?: string };
        type CfgRes = {
          host?: HostConfig[];
          project?: Array<{ agent?: CfgAgent[][] }>;
        };
        const cfgRes = await apiGet<CfgRes>('/config', ctx);
        for (const proj of cfgRes?.project ?? []) {
          for (const team of proj.agent ?? []) {
            for (const a of team) {
              if (a.id === agentId) {
                agent = a;
                resolvedHost = resolveAgentHost(cfgRes?.host, a.host);
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[baxian] couldn't fetch agent config (${err instanceof Error ? err.message : err}); attaching as local`);
      }

      const dims = readTtyDimensions(process.stdout);
      if (agent && agent.mode === 'remote' && resolvedHost) {
        const sshArgs = buildRemoteAttachSshArgs(resolvedHost, agentId, dims);
        const result = spawnSync('ssh', sshArgs, { stdio: 'inherit' });
        process.exit(result.status ?? 0);
      }

      for (const cmd of buildLocalAttachCommands(agentId, dims)) {
        const stdio = cmd.kind === 'attach' ? 'inherit' : 'ignore';
        const result = spawnSync(cmd.file, cmd.args, { stdio });
        if (cmd.kind === 'attach') process.exit(result.status ?? 0);
      }
    });

  program
    .command('stop <agent-id>')
    .description('Stop an agent')
    .action((agentId, opts) =>
      withErrors(async () => {
        await apiDelete<{ message?: unknown }>(
          `/agents/${encodeURIComponent(agentId)}/session`,
          ctxOf(opts),
        );
        console.log(`Agent ${agentId} stopped.`);
      }));

  const taskCommand = program.command('task').description('Task management');

  taskCommand
    .command('create')
    .description('Create a new baxian task')
    .option('-p, --project <id>', 'Project ID')
    .option('-t, --title <title>', 'Task title')
    .option('-d, --description <text>', 'Task description (or use --description-file)')
    .option('-f, --description-file <path>', 'Read description from file (- for stdin)')
    .option('-a, --agent <devId>', 'Preferred dev agent ID')
    .action(async (opts) =>
      withErrors(async () => {
        if (opts.description !== undefined && opts.descriptionFile !== undefined) {
          fail('--description and --description-file are mutually exclusive');
        }
        if (!opts.project) fail('--project is required');
        if (!opts.title) fail('--title is required');
        if (!opts.agent) fail('--agent is required');

        let description: string | undefined = opts.description;
        if (opts.descriptionFile !== undefined) {
          if (opts.descriptionFile === '-') {
            description = await readStdin();
          } else {
            description = await readFile(opts.descriptionFile, 'utf-8');
          }
        }
        const result = await apiPost<{ id: string; status: string }>(
          '/tasks',
          {
            projectId: opts.project,
            title: opts.title,
            description: description ?? '',
            preferredAgentId: opts.agent,
          },
          ctxOf(opts),
        );
        console.log(`Created task ${result.id} (status: ${result.status})`);
      }),
    );

  taskCommand
    .command('list')
    .description('List baxian tasks for a project (paginated; global listing was removed)')
    .option('-p, --project <id>', 'Project ID (required)')
    .option('-s, --status <status>', 'Filter by exact status')
    .option('-o, --offset <n>', 'Pagination offset', '0')
    .action(async (opts) =>
      withErrors(async () => {
        if (!opts.project) fail('--project is required');
        const qs = [`projectId=${encodeURIComponent(opts.project)}`];
        if (opts.status) qs.push(`status=${encodeURIComponent(opts.status)}`);
        qs.push(`offset=${encodeURIComponent(String(opts.offset ?? '0'))}`);
        const page = await apiGet<{
          tasks: Array<{ id: string; status: string; title: string; agentId?: string; preferredAgentId?: string }>;
          hasMore: boolean;
          nextOffset: number;
        }>(`/tasks?${qs.join('&')}`, ctxOf(opts));
        const tasks = page?.tasks ?? [];
        if (tasks.length === 0) {
          console.log('No tasks.');
          return;
        }
        console.log('ID\tSTATUS\t\tAGENT\t\tTITLE');
        console.log('---\t------\t\t-----\t\t-----');
        for (const t of tasks) {
          const agent = t.agentId && t.agentId.length > 0 ? t.agentId : t.preferredAgentId ?? '-';
          console.log(`${t.id}\t${t.status}\t${agent}\t${t.title}`);
        }
        if (page?.hasMore) {
          console.log(`… more available; re-run with --offset ${page.nextOffset}`);
        }
      }),
    );

  taskCommand
    .command('cancel <taskId>')
    .description('Cancel a baxian task')
    .action(async (taskId: string, opts) =>
      withErrors(async () => {
        const result = await apiPatch<{ id: string; status: string }>(
          `/tasks/${encodeURIComponent(taskId)}`,
          { status: 'cancelled' },
          ctxOf(opts),
        );
        console.log(`Cancelled task ${result.id} (status: ${result.status})`);
      }),
    );

  const pluginCommand = program.command('plugin').description('Platform plugin management');

  pluginCommand
    .command('install <package>')
    .description('Download a platform plugin package from npm and install it (restart the server to activate)')
    .option(...HOME_OPTION)
    .option('--registry <url>', 'npm registry to download from (defaults to your npm config)')
    .action((spec: string, opts: { home?: string; registry?: string }) =>
      withErrors(async () => {
        const plugin = await installPlatformPlugin(resolveHome(opts.home), spec, opts.registry);
        console.log(`Installed ${plugin.name}@${plugin.version} (platform: ${plugin.platform}).`);
        console.log('Restart the baxian server to activate it.');
      }));

  pluginCommand
    .command('uninstall <package>')
    .description('Uninstall a platform plugin (restart the server to apply)')
    .option(...HOME_OPTION)
    .action((name: string, opts: { home?: string }) =>
      withErrors(async () => {
        await uninstallPlatformPlugin(resolveHome(opts.home), name);
        console.log(`Uninstalled ${name}. Reinstall with "baxian plugin install ${name}" to undo.`);
        console.log('Restart the baxian server to apply; repositories only that plugin recognized will fail config validation until reconfigured.');
      }));

  pluginCommand
    .command('status')
    .description('Show installed platform plugins and whether they load')
    .option(...HOME_OPTION)
    .action((opts: { home?: string }) =>
      withErrors(async () => {
        const statuses = await platformPluginStatuses(resolveHome(opts.home));
        if (statuses.length === 0) {
          console.log('No platform plugins installed.');
        } else {
          console.log('NAME\tVERSION\tPLATFORM\tSTATUS');
          console.log('----\t-------\t--------\t------');
          for (const status of statuses) {
            console.log(`${status.name}\t${status.version}\t${status.ok ? status.platform : '-'}\t${status.ok ? 'ok' : `error: ${status.error}`}`);
          }
        }
        console.log(`Built-in: ${BUILTIN_PLATFORMS.join(', ')}. Plugins take effect at server start.`);
      }));

  program
    .command('check <project>')
    .description('Run preflight checks for all agents in a project')
    .option('--fix', 'Install tmux on hosts where the tmux check fails')
    .action(async (project, opts) => {
      type CheckResult = {
        error?: string;
        agents?: Array<{
          agentId: string;
          mode: string;
          results: Array<{ ok: boolean; step: string; message: string }>;
        }>;
        server?: { results: Array<{ ok: boolean; step: string; message: string }> };
        fixes?: Array<{ hostGroup: string; ok: boolean; message: string }>;
      };
      const result = await apiPost<CheckResult>(
        `/projects/${encodeURIComponent(project)}/checks`,
        opts.fix ? { fix: true } : undefined,
        ctxOf(opts),
      );
      if (!result || result.error) {
        console.error('Check failed:', result?.error ?? 'unknown error');
        process.exit(1);
      }
      for (const agentResult of result.agents ?? []) {
        console.log(`\n[${agentResult.agentId}] (${agentResult.mode})`);
        for (const r of agentResult.results) {
          const mark = r.ok ? 'PASS' : 'FAIL';
          console.log(`  ${mark}  ${r.step}: ${r.message}`);
        }
      }
      if (result.server) {
        console.log('\n[server host]');
        for (const r of result.server.results) {
          const mark = r.ok ? 'PASS' : 'FAIL';
          console.log(`  ${mark}  ${r.step}: ${r.message}`);
        }
      }
      if (opts.fix) {
        console.log('\ntmux install:');
        if (!result.fixes || result.fixes.length === 0) {
          console.log('  nothing to fix — tmux is present on every host');
        }
        for (const f of result.fixes ?? []) {
          const mark = f.ok ? 'PASS' : 'FAIL';
          console.log(`  ${mark}  ${f.hostGroup}: ${f.message}`);
        }
      }
    });

  return program;
}

const isMainModule = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const realArgv = realpathSync(argv1);
    const thisFile = fileURLToPath(import.meta.url);
    return realArgv === thisFile;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  buildCli().parseAsync().catch((err: unknown) => {
    const e = err as { name?: string; message?: string } | null;
    if (e?.name === 'ConfigValidationError') {
      console.error(e.message);
      process.exit(1);
    }
    throw err;
  });
}
