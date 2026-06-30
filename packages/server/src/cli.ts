#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type { HostConfig } from './shared/index.js';
import { startServer } from './index.js';
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

export function buildLocalAttachCommands(
  agentId: string,
  _dims: TtyDimensions | null,
): AttachCommand[] {
  return [
    {
      kind: 'configure',
      file: 'tmux',
      args: ['set-option', '-t', `=${agentId}:`, 'window-size', 'latest'],
    },
    {
      kind: 'configure',
      file: 'tmux',
      args: ['set-option', '-g', 'focus-events', 'on'],
    },
    { kind: 'attach', file: 'tmux', args: ['-u', 'attach-session', '-t', `=${agentId}`] },
  ];
}

export function buildRemoteAttachSshArgs(
  host: HostConfig,
  agentId: string,
  _dims: TtyDimensions | null,
): string[] {
  const quotedId = shellQuote(`=${agentId}`);
  const quotedWindow = shellQuote(`=${agentId}:`);
  const autoSizePrefix =
    `tmux set-option -t ${quotedWindow} window-size latest 2>/dev/null || true; `;
  const focusEventsPrefix = 'tmux set-option -g focus-events on 2>/dev/null || true; ';
  return [
    '-o', 'ConnectTimeout=10',
    ...(host.port !== undefined ? ['-p', String(host.port)] : []),
    '-t',
    '--',
    sshTarget(host),
    wrapRemoteCommand(
      `${autoSizePrefix}${focusEventsPrefix}tmux -u attach-session -t ${quotedId}`,
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
    throw new Error(`${method} ${path} failed (${res.status}): ${text || res.statusText}`);
  }
  const text = await res.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
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
    headers: { 'Content-Type': 'application/json', ...authHeaders(opts) },
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

async function apiDelete(
  path: string,
  opts: { apiUrl?: string; token?: string } = {},
): Promise<unknown> {
  const res = await fetch(`${resolveApiBase(opts)}${path}`, {
    method: 'DELETE',
    headers: authHeaders(opts),
  });
  if (res.status === 204) return null;
  return readResponse(res, 'DELETE', path);
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
    .option('-c, --config <path>', 'Path to config file')
    .action(async (opts) => {
      await startServer(opts.config);
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
      let agent: { mode: 'local' | 'remote'; host?: string | HostConfig } | undefined;
      let resolvedHost: HostConfig | undefined;
      try {
        type CfgAgent = { id: string; mode: 'local' | 'remote'; host?: string | HostConfig };
        type CfgRes = { host?: HostConfig[]; project?: Array<{ agent?: CfgAgent[][] }> };
        const cfgRes = await apiGet<CfgRes>('/config', ctx);
        for (const proj of cfgRes?.project ?? []) {
          for (const pair of proj.agent ?? []) {
            for (const a of pair) {
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
    .action(async (agentId, opts) => {
      await apiDelete(
        `/agents/${encodeURIComponent(agentId)}/session`,
        ctxOf(opts),
      );
      console.log(`Agent ${agentId} stopped.`);
    });

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

  program
    .command('check <project>')
    .description('Run preflight checks for all agents in a project')
    .action(async (project, opts) => {
      type CheckResult = {
        error?: string;
        agents?: Array<{
          agentId: string;
          mode: string;
          results: Array<{ ok: boolean; step: string; message: string }>;
        }>;
      };
      const result = await apiPost<CheckResult>(
        `/projects/${encodeURIComponent(project)}/checks`,
        undefined,
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
    if (e && (e.name === 'ConfigValidationError' || e.name === 'ConfigNotFoundError')) {
      console.error(e.message);
      process.exit(1);
    }
    throw err;
  });
}
