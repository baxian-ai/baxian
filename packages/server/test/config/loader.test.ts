import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  saveConfig,
  prepareConfig,
  ConfigValidationError,
  resolveConfigPath,
  resolveStateDir,
  userConfigPath,
  userStateDir,
  createDefaultConfig,
} from '../../src/config/loader.js';
import type { BaxianConfig } from '../../src/shared/index.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

const VALID_CONFIG = {
  review: { rounds: 5 },
  server: { port: 8080 },
  project: [
    {
      id: 'myproj',
      repo: 'user/repo',
      merge: null,
      agent: [
        [
          { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp' },
        ],
      ],
    },
  ],
};

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
          repo: 'u/r',
          agent: [[{ id: 'dd', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp' }]],
        },
      ],
    };
    const path = join(tempDir, 'baxian.json');
    await writeFile(path, JSON.stringify(minimal));

    const config = await loadConfig(path);
    expect(config.review.rounds).toBe(10);
    expect(config.server.port).toBe(3000);
    expect(config.project[0].merge).toBeNull();
    expect(config.review.mode).toBe('github');
    // afterDone is intentionally NOT defaulted to null — an omitted value stays undefined so a
    // non-GitHub repo can tell "unset → deliver-by-default ('branch')" from explicit "null → review-only".
    expect(config.review.afterDone).toBeUndefined();
  });

  it('normalizes plural keys', async () => {
    const withPlurals = {
      projects: [
        {
          id: 'pp',
          repo: 'u/r',
          agents: [[{ id: 'dd', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp' }]],
        },
      ],
    };
    const path = join(tempDir, 'baxian.json');
    await writeFile(path, JSON.stringify(withPlurals));

    const config = await loadConfig(path);
    expect(config.project).toHaveLength(1);
    expect(config.project[0].agent).toHaveLength(1);
  });

  it('throws ConfigValidationError for invalid config', async () => {
    const invalid = {
      project: [
        {
          id: 'pp',
          repo: 'u/r',
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
  const PROJECT = {
    id: 'pp', repo: 'u/r',
    agent: [[{ id: 'dd', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp' }]],
  };

  it('throws on non-array project (was silently coerced to [] before this fix; would hide malformed shape)', () => {
    // applyDefaults still normalises non-array project to [], so the check must run
    // before defaults — otherwise the validator only sees [] and thinks all is well.
    expect(() => prepareConfig({ project: 'oops' })).toThrow(ConfigValidationError);
    expect(() => prepareConfig({ project: { id: 'p1' } })).toThrow(ConfigValidationError);
    expect(() => prepareConfig({ project: 42 })).toThrow(ConfigValidationError);
  });

  it('rejects malformed project/agent element shapes instead of dropping them or throwing raw TypeError', () => {
    // Before: applyDefaults filter(isRecord) silently dropped non-record projects, and
    // pair.map() threw a raw TypeError on a non-array agent pair. All must be ConfigValidationError.
    expect(() => prepareConfig({ project: [null] })).toThrow(/project\[0\] must be an object/);
    expect(() => prepareConfig({ project: ['oops'] })).toThrow(/project\[0\] must be an object/);
    expect(() => prepareConfig({ project: [{ id: 'pp', repo: 'u/r', agent: 42 }] }))
      .toThrow(/project\[0\]\.agent must be an array of pairs/);
    expect(() => prepareConfig({ project: [{ id: 'pp', repo: 'u/r', agent: [{}] }] }))
      .toThrow(/project\[0\]\.agent\[0\] must be an array of agents/);
    expect(() => prepareConfig({ project: [{ id: 'pp', repo: 'u/r', agent: [[null]] }] }))
      .toThrow(/project\[0\]\.agent\[0\]\[0\] must be an object/);
    // All raised ConfigValidationError, never a raw TypeError.
    expect(() => prepareConfig({ project: [{ id: 'pp', repo: 'u/r', agent: [{}] }] }))
      .toThrow(ConfigValidationError);
  });

  it('accepts a well-formed project/agent shape (happy path still loads)', () => {
    const cfg = prepareConfig({ project: [PROJECT] });
    expect(cfg.project).toHaveLength(1);
    expect(cfg.project[0].agent[0][0].id).toBe('dd');
  });

  it('leaves an omitted host.port undefined (honors ~/.ssh/config), never coercing an invalid value past the validator', () => {
    // Omitted → undefined, so the ssh builders skip -p and ~/.ssh/config's Port is honored.
    const ok = prepareConfig({ host: [{ id: 'box', hostname: 'h' }], project: [] });
    expect(ok.host[0].port).toBeUndefined();
    // A non-numeric / string port must reach validateHosts and be rejected, not silently coerced.
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
    // normalizeConfig silently coerces non-object raw → {}; combined with the
    // missing-project zero-config path that previously made `"oops"` / `null` /
    // `[]` accepted as phantom default config. Pin top-level shape so garbage
    // file content fails fast.
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

  it('silently drops legacy github field from on-disk config (webhook ingestion was removed)', () => {
    const cfg = prepareConfig({
      github: { secret: 'webhook-secret-from-old-config' },
      project: [PROJECT],
    });
    expect((cfg as unknown as { github?: unknown }).github).toBeUndefined();
  });

  it('falls back to default port when server.port is non-finite', () => {
    const cfg = prepareConfig({
      server: { port: 'eight thousand' },
      project: [PROJECT],
    });
    expect(cfg.server.port).toBe(3000);
  });

  it('drops server.token / host when not strings', () => {
    const cfg = prepareConfig({
      server: { token: { x: 1 }, host: 7 },
      project: [PROJECT],
    });
    expect(cfg.server.token).toBeUndefined();
    expect(cfg.server.host).toBeUndefined();
  });

  it('keeps a valid positive integer server.githubPollIntervalMs within [1000ms, 2^31-1]', () => {
    expect(
      prepareConfig({ server: { githubPollIntervalMs: 1000 }, project: [PROJECT] })
        .server.githubPollIntervalMs,
    ).toBe(1000);
    expect(
      prepareConfig({ server: { githubPollIntervalMs: 60000 }, project: [PROJECT] })
        .server.githubPollIntervalMs,
    ).toBe(60000);
    expect(
      prepareConfig({ server: { githubPollIntervalMs: 2147483647 }, project: [PROJECT] })
        .server.githubPollIntervalMs,
    ).toBe(2147483647);
  });

  it('drops non-number / non-finite server.githubPollIntervalMs at the loader (type narrowing only — out-of-range goes to the validator pass)', () => {
    // loader is type-narrow only; finite numbers (incl. out-of-range)
    // are preserved here and surfaced as ConfigValidationError by the
    // validator. See validator.test.ts for the range-reject cases.
    expect(
      prepareConfig({ server: { githubPollIntervalMs: undefined }, project: [PROJECT] })
        .server.githubPollIntervalMs,
    ).toBeUndefined();
    expect(() =>
      prepareConfig({ server: { githubPollIntervalMs: '30000' }, project: [PROJECT] }),
    ).not.toThrow();
    expect(
      prepareConfig({ server: { githubPollIntervalMs: '30000' }, project: [PROJECT] })
        .server.githubPollIntervalMs,
    ).toBeUndefined();
    expect(
      prepareConfig({ server: { githubPollIntervalMs: NaN }, project: [PROJECT] })
        .server.githubPollIntervalMs,
    ).toBeUndefined();
  });

  it('rejects out-of-range / non-integer server.githubPollIntervalMs via ConfigValidationError (so PATCH returns 400 instead of silently falling back)', () => {
    // 500 — below 1s floor (would exhaust GitHub rate limit)
    expect(() =>
      prepareConfig({ server: { githubPollIntervalMs: 500 }, project: [PROJECT] }),
    ).toThrow(ConfigValidationError);
    // 1500.5 — non-integer (setInterval clamps to 1ms)
    expect(() =>
      prepareConfig({ server: { githubPollIntervalMs: 1500.5 }, project: [PROJECT] }),
    ).toThrow(ConfigValidationError);
    // 0 / negative
    expect(() =>
      prepareConfig({ server: { githubPollIntervalMs: 0 }, project: [PROJECT] }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      prepareConfig({ server: { githubPollIntervalMs: -1000 }, project: [PROJECT] }),
    ).toThrow(ConfigValidationError);
    // 2^31 — above timer ceiling (TimeoutOverflowWarning)
    expect(() =>
      prepareConfig({ server: { githubPollIntervalMs: 2147483648 }, project: [PROJECT] }),
    ).toThrow(ConfigValidationError);
  });

  it('keeps valid server tmux probe settings', () => {
    const cfg = prepareConfig({
      server: {
        tmuxProbePollIntervalMs: 10000,
        tmuxProbeTimeoutMs: 3000,
        tmuxProbeConcurrency: 4,
      },
      project: [PROJECT],
    });
    expect(cfg.server.tmuxProbePollIntervalMs).toBe(10000);
    expect(cfg.server.tmuxProbeTimeoutMs).toBe(3000);
    expect(cfg.server.tmuxProbeConcurrency).toBe(4);
  });

  it('drops non-number server tmux probe settings', () => {
    const cfg = prepareConfig({
      server: {
        tmuxProbePollIntervalMs: '10000',
        tmuxProbeTimeoutMs: null,
        tmuxProbeConcurrency: Number.POSITIVE_INFINITY,
      },
      project: [PROJECT],
    });
    expect(cfg.server.tmuxProbePollIntervalMs).toBeUndefined();
    expect(cfg.server.tmuxProbeTimeoutMs).toBeUndefined();
    expect(cfg.server.tmuxProbeConcurrency).toBeUndefined();
  });

  it('passes through server.bootstrapRetryIntervalMs', () => {
    const config = prepareConfig({
      server: { port: 3000, bootstrapRetryIntervalMs: 30_000 },
      project: [PROJECT],
    });
    expect(config.server.bootstrapRetryIntervalMs).toBe(30_000);
  });

  it('drops non-finite server.bootstrapRetryIntervalMs', () => {
    const config = prepareConfig({
      server: { port: 3000, bootstrapRetryIntervalMs: 'oops' as unknown as number },
      project: [PROJECT],
    });
    expect(config.server.bootstrapRetryIntervalMs).toBeUndefined();
  });

  it('falls back to default rounds when review.rounds is non-finite', () => {
    const cfg = prepareConfig({
      review: { rounds: NaN },
      project: [PROJECT],
    });
    expect(cfg.review.rounds).toBe(10);
  });

  it('defaults review.mode to github but leaves an omitted afterDone undefined (preserves "unset")', () => {
    const cfg = prepareConfig({
      review: { rounds: 10 },
      project: [PROJECT],
    });
    expect(cfg.review.mode).toBe('github');
    // NOT defaulted to null — non-GitHub repos distinguish unset (deliver-by-default) from
    // explicit null (review-only); GitHub collapses both via `?? null`, so this is behavior-neutral.
    expect(cfg.review.afterDone).toBeUndefined();
  });

  it('passes through review.mode=server and afterDone=pr', () => {
    const cfg = prepareConfig({
      review: { rounds: 10, mode: 'server', afterDone: 'pr' },
      // Server mode demands a qa partner per pair — extend the shared fixture.
      project: [{
        ...PROJECT,
        agent: [[
          { id: 'dd', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp' },
          { id: 'qq', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp' },
        ]],
      }],
    });
    expect(cfg.review.mode).toBe('server');
    expect(cfg.review.afterDone).toBe('pr');
  });

  it('rejects server mode with a dev-only pair', () => {
    expect(() => prepareConfig({
      review: { rounds: 10, mode: 'server' },
      project: [PROJECT],
    })).toThrow(/qa partner/);
  });

  it('passes through invalid review.mode for the validator to reject', () => {
    expect(() => prepareConfig({
      review: { rounds: 10, mode: 'gitlab' },
      project: [PROJECT],
    })).toThrow(/review\.mode/);
  });

  it('rejects legacy top-level "codereview" with a clear rename message (no silent fallback to default rounds)', () => {
    expect(() => prepareConfig({
      codereview: { rounds: 5 },
      project: [PROJECT],
    })).toThrow(/codereview was renamed to review/);
  });

  it('rejects partial server.https (missing certFile) instead of silently dropping to plain HTTP', () => {
    expect(() => prepareConfig({
      review: { rounds: 10 },
      server: { port: 443, https: { keyFile: '/etc/ssl/key.pem' } },
      project: [PROJECT],
    })).toThrow(/server\.https\.certFile/);
  });

  it('rejects empty-string server.https.keyFile (was previously silently dropped)', () => {
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

  it('rejects non-object server.https (was silently dropped before)', () => {
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

  it('rejects non-array server.allowedHosts (was silently dropped before)', () => {
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
});

describe('saveConfig', () => {
  it('writes config and creates backup', async () => {
    const path = join(tempDir, 'baxian.json');
    await writeFile(path, JSON.stringify({ old: true }));

    await saveConfig(path, { ...VALID_CONFIG } as BaxianConfig);

    const files = await readdir(tempDir);
    const backups = files.filter(f => /baxian\.json\.\d{8}-\d{6}$/.test(f));
    expect(backups).toHaveLength(1);

    const config = await loadConfig(path);
    expect(config.server.port).toBe(8080);
  });

  it('writes config even when no previous file exists', async () => {
    const path = join(tempDir, 'baxian.json');

    await saveConfig(path, { ...VALID_CONFIG } as BaxianConfig);

    const config = await loadConfig(path);
    expect(config.project[0].id).toBe('myproj');
  });
});

describe('resolveConfigPath / resolveStateDir / userConfigPath / userStateDir', () => {
  let cwdReal: string;
  let homeReal: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    const fakeHome = await mkdtemp(join(tmpdir(), 'baxian-home-'));
    // macOS /var/folders → /private/var/folders aliasing breaks path equality unless canonicalised.
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

  it('userConfigPath() points to ~/.baxian/config.json', () => {
    expect(userConfigPath()).toBe(join(homeReal, '.baxian', 'config.json'));
  });

  it('userStateDir() points to ~/.baxian', () => {
    expect(userStateDir()).toBe(join(homeReal, '.baxian'));
  });

  it('resolveConfigPath(explicit) returns the resolved path without fs check', async () => {
    expect(await resolveConfigPath('/some/path/baxian.json')).toBe('/some/path/baxian.json');
  });

  it('resolveConfigPath() returns cwd/baxian.json when it exists', async () => {
    const cwdConfig = join(cwdReal, 'baxian.json');
    await writeFile(cwdConfig, JSON.stringify({ project: [] }));
    expect(await resolveConfigPath()).toBe(cwdConfig);
  });

  it('resolveConfigPath() falls back to ~/.baxian/config.json when cwd has none', async () => {
    const user = join(homeReal, '.baxian', 'config.json');
    await createDefaultConfig(user);
    expect(await resolveConfigPath()).toBe(user);
  });

  it('resolveConfigPath() returns null when neither location has a config', async () => {
    expect(await resolveConfigPath()).toBeNull();
  });

  it('resolveStateDir(cwd config) returns sibling .baxian/', () => {
    expect(resolveStateDir(join(cwdReal, 'baxian.json'))).toBe(join(cwdReal, '.baxian'));
  });

  it('resolveStateDir(user config) returns ~/.baxian (config and state share the dir)', () => {
    expect(resolveStateDir(userConfigPath())).toBe(userStateDir());
  });

  it('resolveStateDir(alias inside ~/.baxian/) still returns ~/.baxian — not nested', () => {
    // Symlink/alias scenario: user does `ln -s ~/.baxian/config.json ~/.baxian/cfg-alias.json`
    // then runs `baxian -c ~/.baxian/cfg-alias.json`. String-equality on the full path
    // would miss this and fall back to dirname/.baxian → ~/.baxian/.baxian/ (nested),
    // splitting locks/state from the zero-config path. dirname match keeps them shared.
    const alias = join(homeReal, '.baxian', 'cfg-alias.json');
    expect(resolveStateDir(alias)).toBe(userStateDir());
  });

  it('resolveStateDir(deeper subdir under ~/.baxian/) falls through to sibling .baxian/', () => {
    // User actively chose a subdir — preserve sibling-state convention there.
    const deep = join(homeReal, '.baxian', 'sub', 'cfg.json');
    expect(resolveStateDir(deep)).toBe(join(homeReal, '.baxian', 'sub', '.baxian'));
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
    const target = join(homeReal, '.baxian', 'config.json');
    await createDefaultConfig(target);
    const fileStat = await stat(target);
    expect(fileStat.isFile()).toBe(true);
    const parsed = JSON.parse(await readFile(target, 'utf-8'));
    expect(parsed.project).toEqual([]);
    expect(parsed.server.port).toBe(3000);
    expect(parsed.review.rounds).toBe(10);
  });

  it('creates the parent directory chain', async () => {
    const target = join(homeReal, '.baxian', 'config.json');
    await createDefaultConfig(target);
    const dirStat = await stat(join(homeReal, '.baxian'));
    expect(dirStat.isDirectory()).toBe(true);
  });

  it('template content loads cleanly through loadConfig (validator + normalizer)', async () => {
    const target = join(homeReal, '.baxian', 'config.json');
    await createDefaultConfig(target);
    // loadConfig runs prepareConfig (normalizer + validator). Empty project is now allowed,
    // so a freshly auto-created config must load without ConfigValidationError.
    const cfg = await loadConfig(target);
    expect(cfg.project).toEqual([]);
  });
});
