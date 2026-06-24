import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCli } from '../../src/cli.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const r = responses[i] ?? { status: 200, body: null };
    i += 1;
    const status = r.status ?? 200;
    const text = r.body === null || r.body === undefined ? '' : JSON.stringify(r.body);
    return new Response(text, { status });
  });
  return { fn, calls };
}

describe('CLI task subcommands', () => {
  let originalFetch: typeof globalThis.fetch;
  let logs: string[];
  let errors: string[];
  let exitCode: number | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    logs = [];
    errors = [];
    exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.join(' '));
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`__exit__:${exitCode}`);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('registers task command with create/list/cancel subcommands', () => {
    const cli = buildCli();
    const taskCmd = cli.commands.find((c) => c.name() === 'task');
    expect(taskCmd).toBeDefined();
    const subs = taskCmd!.commands.map((c) => c.name());
    expect(subs).toContain('create');
    expect(subs).toContain('list');
    expect(subs).toContain('cancel');
  });

  it('task create posts /tasks with body', async () => {
    const { fn, calls } = mockFetch([
      { status: 201, body: { id: 't-1', status: 'pending', title: 'Hello', preferredAgentId: 'dev-1' } },
    ]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const cli = buildCli();
    await cli.parseAsync([
      'node',
      'cli',
      '--api-url', 'http://srv:9000',
      'task', 'create',
      '--project', 'proj',
      '--title', 'Hello',
      '--description', 'desc',
      '--agent', 'dev-1',
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://srv:9000/api/tasks');
    expect(calls[0].init.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      projectId: 'proj',
      title: 'Hello',
      description: 'desc',
      preferredAgentId: 'dev-1',
    });
    expect(logs.join('\n')).toContain('t-1');
    expect(logs.join('\n')).toContain('pending');
  });

  it('task create reads --description-file from disk', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'baxian-cli-'));
    const filePath = join(tmp, 'desc.md');
    await writeFile(filePath, '# Long markdown\nbody');

    const { fn, calls } = mockFetch([
      { status: 201, body: { id: 't-2', status: 'pending' } },
    ]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    try {
      const cli = buildCli();
      await cli.parseAsync([
        'node',
        'cli',
        '--api-url', 'http://srv:9000',
        'task', 'create',
        '--project', 'proj',
        '--title', 'T',
        '--description-file', filePath,
        '--agent', 'dev-1',
      ]);

      const body = JSON.parse(String(calls[0].init.body));
      expect(body.description).toBe('# Long markdown\nbody');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('task create without --description sends empty description', async () => {
    const { fn, calls } = mockFetch([
      { status: 201, body: { id: 't-nodesc', status: 'pending' } },
    ]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const cli = buildCli();
    await cli.parseAsync([
      'node',
      'cli',
      '--api-url', 'http://srv:9000',
      'task', 'create',
      '--project', 'proj',
      '--title', 'No desc',
      '--agent', 'dev-1',
    ]);

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.description).toBe('');
  });

  it('task create errors when both --description and --description-file given', async () => {
    const cli = buildCli();
    await expect(
      cli.parseAsync([
        'node',
        'cli',
        'task', 'create',
        '--project', 'proj',
        '--title', 'T',
        '--description', 'inline',
        '--description-file', '/tmp/whatever',
        '--agent', 'dev-1',
      ]),
    ).rejects.toThrow(/__exit__:1/);
    expect(errors.join('\n')).toMatch(/--description.*--description-file/);
  });

  it('task create errors when required options missing', async () => {
    const cli = buildCli();
    await expect(
      cli.parseAsync([
        'node',
        'cli',
        'task', 'create',
        '--title', 'T',
        '--description', 'd',
        '--agent', 'dev-1',
      ]),
    ).rejects.toThrow(/__exit__:1/);
    expect(errors.join('\n')).toMatch(/--project/);
  });

  it('task list requires --project (global listing removed)', async () => {
    const cli = buildCli();
    await expect(
      cli.parseAsync([
        'node',
        'cli',
        '--api-url', 'http://srv:9000',
        'task', 'list',
      ]),
    ).rejects.toThrow(/__exit__:1/);
    expect(errors.join('\n')).toMatch(/--project/);
  });

  it('task list with --project reads the paginated response and includes offset', async () => {
    const { fn, calls } = mockFetch([
      {
        status: 200,
        body: {
          tasks: [
            { id: 't-1', status: 'pending', title: 'A', preferredAgentId: 'dev-1', agentId: '' },
            { id: 't-2', status: 'in_progress', title: 'B', preferredAgentId: 'dev-1', agentId: 'dev-1' },
          ],
          hasMore: false,
          nextOffset: 2,
        },
      },
    ]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const cli = buildCli();
    await cli.parseAsync([
      'node',
      'cli',
      '--api-url', 'http://srv:9000',
      'task', 'list',
      '--project', 'proj',
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://srv:9000/api/tasks?projectId=proj&offset=0');
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    const out = logs.join('\n');
    expect(out).toContain('t-1');
    expect(out).toContain('t-2');
    expect(out).toContain('pending');
    expect(out).toContain('in_progress');
  });

  it('task list honors --status and surfaces a more-available hint', async () => {
    const { fn, calls } = mockFetch([
      {
        status: 200,
        body: {
          tasks: [{ id: 't-1', status: 'pending', title: 'A', preferredAgentId: 'dev-1', agentId: '' }],
          hasMore: true,
          nextOffset: 20,
        },
      },
    ]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const cli = buildCli();
    await cli.parseAsync([
      'node',
      'cli',
      '--api-url', 'http://srv:9000',
      'task', 'list',
      '--project', 'p one',
      '--status', 'pending',
    ]);

    expect(calls[0].url).toBe('http://srv:9000/api/tasks?projectId=p%20one&status=pending&offset=0');
    const out = logs.join('\n');
    expect(out).toContain('t-1');
    expect(out).toContain('--offset 20');
  });

  it('task list prints "No tasks" on an empty page', async () => {
    const { fn } = mockFetch([{ status: 200, body: { tasks: [], hasMore: false, nextOffset: 0 } }]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const cli = buildCli();
    await cli.parseAsync([
      'node',
      'cli',
      '--api-url', 'http://srv:9000',
      'task', 'list',
      '--project', 'proj',
    ]);
    expect(logs.join('\n')).toContain('No tasks');
  });

  it('task cancel patches /tasks/:id with cancelled', async () => {
    const { fn, calls } = mockFetch([
      { status: 200, body: { id: 't-9', status: 'cancelled' } },
    ]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const cli = buildCli();
    await cli.parseAsync([
      'node',
      'cli',
      '--api-url', 'http://srv:9000',
      'task', 'cancel', 't-9',
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://srv:9000/api/tasks/t-9');
    expect(calls[0].init.method).toBe('PATCH');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ status: 'cancelled' });
    expect(logs.join('\n')).toContain('t-9');
    expect(logs.join('\n')).toContain('cancelled');
  });

  it('task cancel surfaces server error and exits 1', async () => {
    const { fn } = mockFetch([{ status: 404, body: { error: 'Task not found' } }]);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const cli = buildCli();
    await expect(
      cli.parseAsync([
        'node',
        'cli',
        '--api-url', 'http://srv:9000',
        'task', 'cancel', 't-missing',
      ]),
    ).rejects.toThrow(/__exit__:1/);
    expect(errors.join('\n')).toMatch(/PATCH \/tasks\/t-missing failed \(404\)/);
  });

  it('assign command no longer exists', () => {
    const cli = buildCli();
    const names = cli.commands.map((c) => c.name());
    expect(names).not.toContain('assign');
  });
});
