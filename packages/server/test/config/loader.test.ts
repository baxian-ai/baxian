import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, lstat, mkdtemp, writeFile, rm, readdir, readFile, realpath, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  saveConfig,
  prepareConfig,
  ConfigValidationError,
  resolveHome,
  createDefaultConfig,
} from '../../src/config/loader.js';
import type { BaxianConfig } from '../../src/shared/index.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true });
});

const VALID_CONFIG = {
  review: { rounds: 5 },
  server: { port: 8080 },
  project: [
    {
      id: 'myproj',
      repo: 'https://github.com/user/repo.git',
      merge: null,
      agent: [
        [
          { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp' },
          { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/qa-1' },
        ],
      ],
    },
  ],
};

const PROJECT = {
  id: 'pp', repo: 'https://github.com/u/r.git',
  agent: [[
    { id: 'dd', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp' },
    { id: 'qq', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/qq' },
  ]],
};

function withServer(server: Record<string, unknown>): BaxianConfig {
  return prepareConfig({ server, project: [PROJECT] });
}

describe('loadConfig', () => {
  it('loads and returns a valid config', async () => {
    const path = join(tempDir, 'baxian.json');
    await writeFile(path, JSON.stringify(VALID_CONFIG));

    const config = await loadConfig(path);
    expect(config.server.port).toBe(8080);
    expect(config.project[0].id).toBe('myproj');
  });

  it('applies defaults for missing optional fields', async () => {
    const minimal = {
      project: [
        {
          id: 'pp',
          repo: 'https://github.com/u/r.git',
          agent: [[
            { id: 'dd', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp' },
            { id: 'qq', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/qq' },
          ]],
        },
      ],
    };
    const path = join(tempDir, 'baxian.json');
    await writeFile(path, JSON.stringify(minimal));

    const config = await loadConfig(path);
    expect(config.review.rounds).toBe(10);
    expect(config.server.port).toBe(3000);
    expect(config.project[0].merge).toBeNull();
    expect(config.review).toEqual({ rounds: 10 });
  });

  it('rejects plural aliases instead of maintaining a second config dialect', async () => {
    const withPlurals = {
      projects: [
        {
          id: 'pp',
          repo: 'https://github.com/u/r.git',
          agents: [[
            { id: 'dd', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp' },
            { id: 'qq', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/qq' },
          ]],
        },
      ],
    };
    const path = join(tempDir, 'baxian.json');
    await writeFile(path, JSON.stringify(withPlurals));

    await expect(loadConfig(path)).rejects.toThrow(/projects: unknown configuration key/);
  });

  it('throws ConfigValidationError for invalid config', async () => {
    const invalid = {
      project: [
        {
          id: 'pp',
          repo: 'https://github.com/u/r.git',
          agent: [[{ id: 'q1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp' }]],
        },
      ],
    };
    const path = join(tempDir, 'baxian.json');
    await writeFile(path, JSON.stringify(invalid));

    await expect(loadConfig(path)).rejects.toThrow(ConfigValidationError);
  });

  it('throws on missing config file', async () => {
    await expect(loadConfig(join(tempDir, 'nope.json'))).rejects.toThrow();
  });

  it('throws on invalid JSON', async () => {
    const path = join(tempDir, 'baxian.json');
    await writeFile(path, 'not json {{{');
    await expect(loadConfig(path)).rejects.toThrow();
  });
});

describe('prepareConfig type guards', () => {
  it('throws ConfigValidationError when project is not an array', () => {
    expect(() => prepareConfig({ project: 'oops' })).toThrow(ConfigValidationError);
    expect(() => prepareConfig({ project: { id: 'p1' } })).toThrow(ConfigValidationError);
    expect(() => prepareConfig({ project: 42 })).toThrow(ConfigValidationError);
  });

  it('rejects malformed project/agent element shapes instead of dropping them or throwing raw TypeError', () => {
    expect(() => prepareConfig({ project: [null] })).toThrow(/project\[0\] must be an object/);
    expect(() => prepareConfig({ project: ['oops'] })).toThrow(/project\[0\] must be an object/);
    expect(() => prepareConfig({ project: [{ id: 'pp', repo: 'https://github.com/u/r.git', agent: 42 }] }))
      .toThrow(/project\[0\]\.agent must be an array of Agent Teams/);
    expect(() => prepareConfig({ project: [{ id: 'pp', repo: 'https://github.com/u/r.git', agent: [{}] }] }))
      .toThrow(/project\[0\]\.agent\[0\] must be an array of agents/);
    expect(() => prepareConfig({ project: [{ id: 'pp', repo: 'https://github.com/u/r.git', agent: [[null]] }] }))
      .toThrow(/project\[0\]\.agent\[0\]\[0\] must be an object/);
    expect(() => prepareConfig({ project: [{ id: 'pp', repo: 'https://github.com/u/r.git', agent: [{}] }] }))
      .toThrow(ConfigValidationError);
  });

  it('accepts a well-formed project/agent shape (happy path still loads)', () => {
    const cfg = prepareConfig({ project: [PROJECT] });
    expect(cfg.project).toHaveLength(1);
    expect(cfg.project[0].agent[0][0].id).toBe('dd');
  });

  it('leaves an omitted host.port undefined (honors ~/.ssh/config), never coercing an invalid value past the validator', () => {
    const ok = prepareConfig({ host: [{ id: 'box', hostname: 'h' }], project: [] });
    expect(ok.host[0].port).toBeUndefined();
    expect(() => prepareConfig({ host: [{ id: 'box', hostname: 'h', port: '2222' }], project: [] }))
      .toThrow(/host\[0\]\.port/);
    expect(() => prepareConfig({ host: [{ id: 'box', hostname: 'h', port: '22; touch x' }], project: [] }))
      .toThrow(ConfigValidationError);
    expect(() => prepareConfig({ host: [{ id: 'box', hostname: 'h', port: 70000 }], project: [] }))
      .toThrow(/host\[0\]\.port/);
  });

  it('rejects non-object host entries instead of silently dropping them (host: ["prod"] → []) ', () => {
    expect(() => prepareConfig({ host: ['prod'], project: [] })).toThrow(/host\[0\] must be an object/);
    expect(() => prepareConfig({ host: [{ id: 'box', hostname: 'h' }, 42], project: [] }))
      .toThrow(ConfigValidationError);
  });

  it('throws on malformed top-level raw config (string / null / array / number / boolean)', () => {
    expect(() => prepareConfig('oops')).toThrow(/config must be a JSON object \(got string\)/);
    expect(() => prepareConfig(null)).toThrow(/got null/);
    expect(() => prepareConfig([])).toThrow(/got array/);
    expect(() => prepareConfig(42)).toThrow(/got number/);
    expect(() => prepareConfig(true)).toThrow(/got boolean/);
    expect(() => prepareConfig(undefined)).toThrow(/got undefined/);
  });

  it('accepts missing project field (zero-config first run, server starts with project: [])', () => {
    const cfg = prepareConfig({});
    expect(cfg.project).toEqual([]);
  });

  it('accepts explicit empty project array', () => {
    const cfg = prepareConfig({ project: [] });
    expect(cfg.project).toEqual([]);
  });

  it('rejects retired config fields instead of silently discarding them', () => {
    expect(() => prepareConfig({
      github: { secret: 'webhook-secret-from-old-config' },
      project: [PROJECT],
    })).toThrow(/github: unknown configuration key/);
  });

  it('rejects an explicitly invalid server.port', () => {
    expect(() => withServer({ port: 'eight thousand' })).toThrow(/server\.port/);
  });

  it('rejects invalid server.token and server.host values', () => {
    expect(() => withServer({ token: { x: 1 } })).toThrow(/server\.token/);
    expect(() => withServer({ host: 7 })).toThrow(/server\.host/);
  });

  it('keeps a valid positive integer server.platformPollIntervalMs within [1000ms, 2^31-1]', () => {
    for (const value of [1000, 60000, 2147483647]) {
      expect(withServer({ platformPollIntervalMs: value }).server.platformPollIntervalMs).toBe(value);
    }
  });

  it('defaults an omitted platform poll interval and rejects explicitly invalid values', () => {
    expect(withServer({}).server.platformPollIntervalMs).toBe(30_000);
    for (const value of ['30000', NaN]) {
      expect(() => withServer({ platformPollIntervalMs: value })).toThrow(ConfigValidationError);
    }
  });

  it('rejects out-of-range / non-integer server.platformPollIntervalMs via ConfigValidationError (so PATCH returns 400 instead of silently falling back)', () => {
    for (const value of [500, 1500.5, 0, -1000, 2147483648]) {
      expect(() => withServer({ platformPollIntervalMs: value })).toThrow(ConfigValidationError);
    }
  });

  it('keeps valid server tmux probe settings', () => {
    const cfg = withServer({
      tmuxProbePollIntervalMs: 10000,
      tmuxProbeTimeoutMs: 3000,
      tmuxProbeConcurrency: 4,
    });
    expect(cfg.server.tmuxProbePollIntervalMs).toBe(10000);
    expect(cfg.server.tmuxProbeTimeoutMs).toBe(3000);
    expect(cfg.server.tmuxProbeConcurrency).toBe(4);
  });

  it('rejects explicitly invalid tmux probe settings', () => {
    for (const server of [
      { tmuxProbePollIntervalMs: '10000' },
      { tmuxProbeTimeoutMs: null },
      { tmuxProbeConcurrency: Number.POSITIVE_INFINITY },
    ]) expect(() => withServer(server)).toThrow(ConfigValidationError);
  });

  it('passes through server.bootstrapRetryIntervalMs', () => {
    const config = withServer({ port: 3000, bootstrapRetryIntervalMs: 30_000 });
    expect(config.server.bootstrapRetryIntervalMs).toBe(30_000);
  });

  it('rejects an explicitly invalid server.bootstrapRetryIntervalMs', () => {
    expect(() => withServer({ port: 3000, bootstrapRetryIntervalMs: 'oops' }))
      .toThrow(ConfigValidationError);
  });

  it('passes through dispatch reconcile knobs', () => {
    const config = withServer({
      port: 3000,
      dispatchReconcileIntervalMs: 15_000,
      dispatchBusyWaitBudgetMs: 600_000,
      dispatchReconcileMaxAttempts: 5,
    });
    expect(config.server.dispatchReconcileIntervalMs).toBe(15_000);
    expect(config.server.dispatchBusyWaitBudgetMs).toBe(600_000);
    expect(config.server.dispatchReconcileMaxAttempts).toBe(5);
  });

  it('defaults dispatch reconcile knobs when absent', () => {
    const config = withServer({ port: 3000 });
    expect(config.server.dispatchReconcileIntervalMs).toBe(30_000);
    expect(config.server.dispatchBusyWaitBudgetMs).toBe(1_800_000);
    expect(config.server.dispatchReconcileMaxAttempts).toBe(3);
  });

  it('rejects explicitly invalid review.rounds', () => {
    expect(() => prepareConfig({
      review: { rounds: NaN },
      project: [PROJECT],
    })).toThrow(/review\.rounds/);
  });

  it('keeps review config limited to rounds', () => {
    const cfg = prepareConfig({
      review: { rounds: 10 },
      project: [PROJECT],
    });
    expect(cfg.review).toEqual({ rounds: 10 });
  });

  it('rejects unknown keys at every supported scope', async () => {
    const path = join(tempDir, 'baxian.json');
    await writeFile(path, JSON.stringify({
      legacyTop: true,
      review: { rounds: 10, mode: 'server', afterDone: 'pr' },
      server: { reviewBaseDir: '/tmp/reviews' },
      project: [{
        ...PROJECT,
        review: { mode: 'server' },
        agent: PROJECT.agent.map(team => team.map(agent => ({
          ...agent,
          serverReview: true,
        }))),
      }],
    }));
    await expect(loadConfig(path)).rejects.toMatchObject({
      errors: expect.arrayContaining([
        { path: 'legacyTop', message: 'unknown configuration key' },
        { path: 'review.mode', message: 'unknown configuration key' },
        { path: 'review.afterDone', message: 'unknown configuration key' },
        { path: 'server.reviewBaseDir', message: 'unknown configuration key' },
        { path: 'project[0].review', message: 'unknown configuration key' },
        { path: 'project[0].agent[0][0].serverReview', message: 'unknown configuration key' },
      ]),
    });
  });

  it('rejects an incomplete Agent Team', () => {
    expect(() => prepareConfig({
      review: { rounds: 10 },
      project: [{
        id: 'pp',
        repo: 'https://github.com/u/r.git',
        agent: [[{ id: 'dd', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp' }]],
      }],
    })).toThrow(/exactly one qa agent/);
  });

  it('rejects partial server.https (missing certFile) instead of silently dropping to plain HTTP', () => {
    expect(() => prepareConfig({
      review: { rounds: 10 },
      server: { port: 443, https: { keyFile: '/etc/ssl/key.pem' } },
      project: [PROJECT],
    })).toThrow(/server\.https\.certFile/);
  });

  it('rejects empty-string server.https.keyFile', () => {
    expect(() => prepareConfig({
      review: { rounds: 10 },
      server: { port: 443, https: { keyFile: '', certFile: '/etc/ssl/cert.pem' } },
      project: [PROJECT],
    })).toThrow(/server\.https\.keyFile/);
  });

  it('rejects non-string entries in allowedHosts instead of silently filtering them out', () => {
    expect(() => prepareConfig({
      review: { rounds: 10 },
      server: { port: 3000, allowedHosts: ['baxian.dev', 123] },
      project: [PROJECT],
    })).toThrow(/server\.allowedHosts\[1\]/);
  });

  it('rejects non-object server.https', () => {
    expect(() => prepareConfig({
      review: { rounds: 10 },
      server: { port: 443, https: true },
      project: [PROJECT],
    })).toThrow(/server\.https/);
    expect(() => prepareConfig({
      review: { rounds: 10 },
      server: { port: 443, https: [] },
      project: [PROJECT],
    })).toThrow(/server\.https/);
    expect(() => prepareConfig({
      review: { rounds: 10 },
      server: { port: 443, https: '/etc/ssl/cert.pem' },
      project: [PROJECT],
    })).toThrow(/server\.https/);
  });

  it('rejects non-array server.allowedHosts', () => {
    expect(() => prepareConfig({
      review: { rounds: 10 },
      server: { port: 3000, allowedHosts: 'baxian.dev' },
      project: [PROJECT],
    })).toThrow(/server\.allowedHosts/);
    expect(() => prepareConfig({
      review: { rounds: 10 },
      server: { port: 3000, allowedHosts: { 0: 'baxian.dev' } },
      project: [PROJECT],
    })).toThrow(/server\.allowedHosts/);
  });

  describe('prepareConfig language passthrough', () => {
    it('keeps a valid language field', () => {
      const config = prepareConfig({ ...{ project: [] }, language: 'zh-CN' });
      expect(config.language).toBe('zh-CN');
    });

    it('omits the language key entirely when absent (default = en-US is a client-side meaning)', () => {
      const config = prepareConfig({ project: [] });
      expect('language' in config).toBe(false);
    });

    it('rejects an invalid language via validation', () => {
      expect(() => prepareConfig({ ...{ project: [] }, language: 'zh-cn' }))
        .toThrow(ConfigValidationError);
    });
  });
});

describe('saveConfig', () => {
  it('writes config and creates backup', async () => {
    const path = join(tempDir, 'baxian.json');
    await writeFile(path, JSON.stringify({ old: true }));

    await saveConfig(path, { ...VALID_CONFIG } as BaxianConfig);

    const backups = (await readdir(tempDir))
      .filter(f => /baxian\.json\.\d{4}(?:-\d{2}){5}-\d{3}$/.test(f));
    expect(backups).toHaveLength(1);

    const config = await loadConfig(path);
    expect(config.server.port).toBe(8080);
  });

  it('continues writing when the same millisecond already has a backup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T10:00:00'));
    const path = join(tempDir, 'baxian.json');
    try {
      await writeFile(path, JSON.stringify({ old: true }));
      await saveConfig(path, { ...VALID_CONFIG } as BaxianConfig);
      await saveConfig(path, {
        ...VALID_CONFIG,
        server: { ...VALID_CONFIG.server, port: 9090 },
      } as BaxianConfig);

      const backups = (await readdir(tempDir))
        .filter(f => /^baxian\.json\.\d{4}(?:-\d{2}){5}-\d{3}$/.test(f));
      expect(backups).toEqual(['baxian.json.2026-04-28-10-00-00-000']);
      expect(await readFile(join(tempDir, backups[0]), 'utf-8')).toBe('{"old":true}');
      expect((await loadConfig(path)).server.port).toBe(9090);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes config even when no previous file exists', async () => {
    const path = join(tempDir, 'baxian.json');

    await saveConfig(path, { ...VALID_CONFIG } as BaxianConfig);

    const config = await loadConfig(path);
    expect(config.project[0].id).toBe('myproj');
  });

  it('preserves a restrictive file mode and leaves no temp file behind', async () => {
    const path = join(tempDir, 'baxian.json');
    await writeFile(path, JSON.stringify({ old: true }));
    await chmod(path, 0o600);

    await saveConfig(path, { ...VALID_CONFIG } as BaxianConfig);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const files = await readdir(tempDir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('rewrites the target of a symlinked config path without breaking the link', async () => {
    const target = join(tempDir, 'real-config.json');
    await writeFile(target, JSON.stringify({ old: true }));
    const link = join(tempDir, 'baxian.json');
    await symlink(target, link);

    await saveConfig(link, { ...VALID_CONFIG } as BaxianConfig);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const config = await loadConfig(target);
    expect(config.server.port).toBe(8080);
  });
});

describe('resolveHome', () => {
  let cwdReal: string;
  let homeReal: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    const fakeHome = await mkdtemp(join(tmpdir(), 'baxian-home-'));
    cwdReal = await realpath(tempDir);
    homeReal = await realpath(fakeHome);
    vi.stubEnv('HOME', homeReal);
    process.chdir(cwdReal);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    await rm(homeReal, { recursive: true });
  });

  it('defaults to ~/.baxian', () => {
    expect(resolveHome()).toBe(join(homeReal, '.baxian'));
  });

  it('uses BAXIAN_HOME when no explicit home is provided', () => {
    vi.stubEnv('BAXIAN_HOME', './env-home');
    expect(resolveHome()).toBe(join(cwdReal, 'env-home'));
  });

  it('gives the explicit home precedence over BAXIAN_HOME', () => {
    vi.stubEnv('BAXIAN_HOME', join(cwdReal, 'env-home'));
    expect(resolveHome('./cli-home')).toBe(join(cwdReal, 'cli-home'));
  });

  it('never discovers a config from cwd', async () => {
    const cwdConfig = join(cwdReal, 'baxian.json');
    await writeFile(cwdConfig, JSON.stringify({ project: [] }));
    expect(resolveHome()).toBe(join(homeReal, '.baxian'));
  });

  it('treats an empty BAXIAN_HOME as unset', () => {
    vi.stubEnv('BAXIAN_HOME', '');
    expect(resolveHome()).toBe(join(homeReal, '.baxian'));
  });

  it('rejects an explicitly empty home', () => {
    expect(() => resolveHome('')).toThrow('home directory must not be empty');
  });
});

describe('createDefaultConfig', () => {
  let cwdReal: string;
  let homeReal: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    const fakeHome = await mkdtemp(join(tmpdir(), 'baxian-home-create-'));
    cwdReal = await realpath(tempDir);
    homeReal = await realpath(fakeHome);
    vi.stubEnv('HOME', homeReal);
    process.chdir(cwdReal);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    await rm(homeReal, { recursive: true });
  });

  it('writes minimal config with empty project list at the given path', async () => {
    const target = join(homeReal, '.baxian', 'baxian.json');
    expect(await createDefaultConfig(target)).toBe(true);
    const fileStat = await stat(target);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await readFile(target, 'utf-8'));
    expect(parsed.project).toEqual([]);
    expect(parsed.server.port).toBe(3000);
    expect(parsed.review.rounds).toBe(10);
  });

  it('creates the parent directory chain', async () => {
    const target = join(homeReal, '.baxian', 'baxian.json');
    await createDefaultConfig(target);
    const dirStat = await stat(join(homeReal, '.baxian'));
    expect(dirStat.isDirectory()).toBe(true);
  });

  it('template content loads cleanly through loadConfig', async () => {
    const target = join(homeReal, '.baxian', 'baxian.json');
    await createDefaultConfig(target);
    const cfg = await loadConfig(target);
    expect(cfg.project).toEqual([]);
  });

  it('never overwrites an existing config', async () => {
    const target = join(homeReal, '.baxian', 'baxian.json');
    expect(await createDefaultConfig(target)).toBe(true);
    await writeFile(target, '{"project":[{"id":"keep"}]}');

    expect(await createDefaultConfig(target)).toBe(false);
    expect(await readFile(target, 'utf-8')).toBe('{"project":[{"id":"keep"}]}');
  });
});
