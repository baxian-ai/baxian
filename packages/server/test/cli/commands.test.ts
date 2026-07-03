import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { buildCli } from '../../src/cli.js';
import { startServer } from '../../src/index.js';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return { ...real, spawnSync: spawnSyncMock };
});

vi.mock('../../src/index.js', () => ({ startServer: vi.fn(async () => {}) }));

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(responses: Array<{ status?: number; body?: unknown; raw?: string }>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const r = responses[i] ?? { status: 200, body: null };
    i += 1;
    const status = r.status ?? 200;
    const text = r.raw ?? (r.body === null || r.body === undefined ? '' : JSON.stringify(r.body));
    return new Response(text === '' ? null : text, { status });
  });
  return { fn, calls };
}

describe('CLI command actions', () => {
  let originalFetch: typeof globalThis.fetch;
  let logs: string[];
  let warns: string[];
  let errors: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    logs = [];
    warns = [];
    errors = [];
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warns.push(args.join(' '));
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.join(' '));
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`__exit__:${typeof code === 'number' ? code : 0}`);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('start (default command)', () => {
    it('runs startServer with the --config path', async () => {
      const cli = buildCli();
      await cli.parseAsync(['node', 'cli', 'start', '--config', '/tmp/baxian.json']);
      expect(vi.mocked(startServer)).toHaveBeenCalledWith('/tmp/baxian.json');
    });
  });

  describe('status', () => {
    it('prints a table of agents', async () => {
      const { fn, calls } = mockFetch([
        {
          body: [
            { id: 'dev-1', runtimeStatus: 'idle', tmuxSessionStatus: 'present', projectId: 'p1' },
            { id: 'qa-1', runtimeStatus: 'busy', tmuxSessionStatus: 'absent' },
          ],
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await buildCli().parseAsync(['node', 'cli', '--api-url', 'http://srv:9000/', 'status']);

      expect(calls[0].url).toBe('http://srv:9000/api/agents');
      const out = logs.join('\n');
      expect(out).toContain('dev-1\t\tidle\t\tpresent\t\tp1');
      expect(out).toContain('qa-1\t\tbusy\t\tabsent\t\t-');
    });

    it('prints "No agents running." for an empty list', async () => {
      const { fn } = mockFetch([{ body: [] }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await buildCli().parseAsync(['node', 'cli', 'status']);
      expect(logs.join('\n')).toContain('No agents running.');
    });

    it('resolves the API base from BAXIAN_API_URL when --api-url is absent', async () => {
      vi.stubEnv('BAXIAN_API_URL', 'http://envhost:8080/');
      const { fn, calls } = mockFetch([{ body: [] }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await buildCli().parseAsync(['node', 'cli', 'status']);
      expect(calls[0].url).toBe('http://envhost:8080/api/agents');
    });

    it('sends Authorization header from --token', async () => {
      const { fn, calls } = mockFetch([{ body: [] }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await buildCli().parseAsync(['node', 'cli', '--token', 'secret-1', 'status']);
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret-1');
    });

    it('surfaces non-JSON API responses as an error', async () => {
      const { fn } = mockFetch([{ raw: '<html>proxy error</html>' }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await expect(buildCli().parseAsync(['node', 'cli', 'status'])).rejects.toThrow(
        /GET \/agents returned non-JSON/,
      );
    });

    it('surfaces HTTP errors with method, path, status and body text', async () => {
      const { fn } = mockFetch([{ status: 503, raw: 'maintenance' }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await expect(buildCli().parseAsync(['node', 'cli', 'status'])).rejects.toThrow(
        /GET \/agents failed \(503\): maintenance/,
      );
    });
  });

  describe('stop', () => {
    it('DELETEs the agent session and logs (204 no-content path)', async () => {
      const { fn, calls } = mockFetch([{ status: 204 }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await buildCli().parseAsync(['node', 'cli', 'stop', 'dev/1']);

      expect(calls[0].url).toContain('/api/agents/dev%2F1/session');
      expect(calls[0].init.method).toBe('DELETE');
      expect(logs.join('\n')).toContain('Agent dev/1 stopped.');
    });

    it('parses a JSON body from DELETE responses (non-204 path)', async () => {
      const { fn } = mockFetch([{ status: 200, body: { stopped: true } }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await buildCli().parseAsync(['node', 'cli', 'stop', 'dev-1']);
      expect(logs.join('\n')).toContain('Agent dev-1 stopped.');
    });
  });

  describe('check', () => {
    it('prints PASS/FAIL per preflight step', async () => {
      const { fn, calls } = mockFetch([
        {
          body: {
            agents: [
              {
                agentId: 'dev-1',
                mode: 'local',
                results: [
                  { ok: true, step: 'tmux', message: 'tmux 3.4' },
                  { ok: false, step: 'runtime', message: 'claude not found' },
                ],
              },
            ],
          },
        },
      ]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await buildCli().parseAsync(['node', 'cli', 'check', 'proj-1']);

      expect(calls[0].url).toContain('/api/projects/proj-1/checks');
      expect(calls[0].init.method).toBe('POST');
      const out = logs.join('\n');
      expect(out).toContain('[dev-1] (local)');
      expect(out).toContain('PASS  tmux: tmux 3.4');
      expect(out).toContain('FAIL  runtime: claude not found');
    });

    it('exits 1 when the server reports an error', async () => {
      const { fn } = mockFetch([{ body: { error: 'no such project' } }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await expect(buildCli().parseAsync(['node', 'cli', 'check', 'nope'])).rejects.toThrow('__exit__:1');
      expect(errors.join('\n')).toContain('Check failed: no such project');
    });

    it('exits 1 when the server returns an empty body', async () => {
      const { fn } = mockFetch([{ status: 200 }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await expect(buildCli().parseAsync(['node', 'cli', 'check', 'proj-1'])).rejects.toThrow('__exit__:1');
      expect(errors.join('\n')).toContain('Check failed: unknown error');
    });
  });

  describe('attach', () => {
    const remoteConfig = {
      host: [{ id: 'box', hostname: 'hz1', user: 'baxian', port: 22 }],
      project: [
        {
          agent: [
            [
              { id: 'dev-r', mode: 'remote', host: 'box' },
              { id: 'dev-l', mode: 'local' },
            ],
          ],
        },
      ],
    };

    it('attaches to a remote agent over ssh and exits with the ssh status', async () => {
      const { fn } = mockFetch([{ body: remoteConfig }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;
      spawnSyncMock.mockReturnValue({ status: 3 });

      await expect(buildCli().parseAsync(['node', 'cli', 'attach', 'dev-r'])).rejects.toThrow('__exit__:3');

      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      const [file, args, opts] = spawnSyncMock.mock.calls[0] as [string, string[], { stdio: string }];
      expect(file).toBe('ssh');
      expect(args).toContain('baxian@hz1');
      expect(args.join(' ')).toContain('attach-session');
      expect(opts.stdio).toBe('inherit');
    });

    it('attaches to a local agent via tmux configure + attach commands', async () => {
      const { fn } = mockFetch([{ body: remoteConfig }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await expect(buildCli().parseAsync(['node', 'cli', 'attach', 'dev-l'])).rejects.toThrow('__exit__:0');

      expect(spawnSyncMock).toHaveBeenCalledTimes(3);
      const files = spawnSyncMock.mock.calls.map((c) => c[0]);
      expect(files).toEqual(['tmux', 'tmux', 'tmux']);
      const attachCall = spawnSyncMock.mock.calls[2] as [string, string[], { stdio: string }];
      expect(attachCall[1]).toEqual(['-u', 'attach-session', '-t', '=dev-l']);
      expect(attachCall[2].stdio).toBe('inherit');
      const configureCall = spawnSyncMock.mock.calls[0] as [string, string[], { stdio: string }];
      expect(configureCall[2].stdio).toBe('ignore');
    });

    it('falls back to local attach with a warning when the config fetch fails', async () => {
      const { fn } = mockFetch([{ status: 500, raw: 'boom' }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await expect(buildCli().parseAsync(['node', 'cli', 'attach', 'ghost'])).rejects.toThrow('__exit__:0');

      expect(warns.join('\n')).toContain("couldn't fetch agent config");
      const attachCall = spawnSyncMock.mock.calls.at(-1) as [string, string[]];
      expect(attachCall[1]).toContain('=ghost');
    });

    it('treats an unknown agent id as local attach', async () => {
      const { fn } = mockFetch([{ body: remoteConfig }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      await expect(buildCli().parseAsync(['node', 'cli', 'attach', 'not-in-config'])).rejects.toThrow(
        '__exit__:0',
      );
      expect(spawnSyncMock.mock.calls.every((c) => c[0] === 'tmux')).toBe(true);
    });
  });

  describe('task create via stdin', () => {
    it('reads the description from stdin with --description-file -', async () => {
      const { fn, calls } = mockFetch([{ status: 201, body: { id: 't-9', status: 'pending' } }]);
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
      Object.defineProperty(process, 'stdin', {
        value: Readable.from([Buffer.from('multiline\nstdin body')]),
        configurable: true,
      });
      try {
        await buildCli().parseAsync([
          'node', 'cli',
          'task', 'create',
          '--project', 'proj',
          '--title', 'T',
          '--description-file', '-',
          '--agent', 'dev-1',
        ]);
      } finally {
        Object.defineProperty(process, 'stdin', stdinDescriptor);
      }

      const body = JSON.parse(String(calls[0].init.body)) as { description: string };
      expect(body.description).toBe('multiline\nstdin body');
      expect(logs.join('\n')).toContain('t-9');
    });
  });
});
