import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/config/validator.js';
import type { BaxianConfig, AgentConfig, ProjectConfig, MergeStrategy, SpecApprovalStrategy } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'dev-1',
    runtime: 'claude-code',
    role: 'dev',
    mode: 'local',
    workdir: '/tmp/test',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<BaxianConfig> = {}): BaxianConfig {
  return {
    review: { rounds: 10 },
    server: DEFAULT_SERVER_CONFIG,
    host: [],
    project: [
      {
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [
          [
            makeAgent({ id: 'dev-1', role: 'dev' }),
            makeAgent({ id: 'qa-1', role: 'qa', runtime: 'codex' }),
          ],
        ],
      },
    ],
    ...overrides,
  };
}

function withProject(project: ProjectConfig, rest: Partial<BaxianConfig> = {}): BaxianConfig {
  return makeConfig({ project: [project], ...rest });
}

function devProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'pp', repo: 'u/r', merge: null,
    agent: [[makeAgent({ id: 'dd', role: 'dev' })]],
    ...overrides,
  };
}

function withServer(server: Partial<BaxianConfig['server']>): BaxianConfig {
  return makeConfig({ server: { ...DEFAULT_SERVER_CONFIG, ...server } });
}

function paths(config: BaxianConfig): string[] {
  return validateConfig(config).map(e => e.path);
}

function hasPathEndingWith(config: BaxianConfig, suffix: string): boolean {
  return validateConfig(config).some(e => e.path.endsWith(suffix));
}

function repoErrors(repo: string) {
  return validateConfig(withProject(devProject({ repo }))).filter(e => e.path.endsWith('.repo'));
}

describe('validateConfig', () => {
  it('returns empty array for valid config', () => {
    expect(validateConfig(makeConfig())).toEqual([]);
  });

  it('accepts dev-only pair (no QA)', () => {
    const config = withProject(devProject({ id: 'pp', agent: [[makeAgent({ id: 'd1', role: 'dev' })]] }));
    expect(validateConfig(config)).toEqual([]);
  });

  it('detects duplicate agent ids across projects', () => {
    const config = makeConfig({
      project: [
        { id: 'p1', repo: 'u/r1', merge: null, agent: [[makeAgent({ id: 'dup', role: 'dev' })]] },
        { id: 'p2', repo: 'u/r2', merge: null, agent: [[makeAgent({ id: 'dup', role: 'dev' })]] },
      ],
    });
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Duplicate agent id');
  });

  it('detects duplicate agent ids within same project', () => {
    const config = withProject(devProject({
      agent: [
        [makeAgent({ id: 'dup', role: 'dev' })],
        [makeAgent({ id: 'dup', role: 'dev' })],
      ],
    }));
    const errors = validateConfig(config);
    expect(errors.some(e => e.message.includes('Duplicate'))).toBe(true);
  });

  it.each<[string, AgentConfig[][], string]>([
    ['detects first agent in pair not being dev', [[makeAgent({ id: 'q1', role: 'qa' })]], 'first'],
    ['detects second agent in pair not being qa', [[
      makeAgent({ id: 'd1', role: 'dev' }),
      makeAgent({ id: 'd2', role: 'dev' }),
    ]], 'second'],
    ['detects more than 2 agents in a pair', [[
      makeAgent({ id: 'd1', role: 'dev' }),
      makeAgent({ id: 'q1', role: 'qa' }),
      makeAgent({ id: 'q2', role: 'qa' }),
    ]], 'at most 2'],
    ['detects empty agent pair', [[]], 'empty'],
  ])('%s', (_label, agent, messagePart) => {
    const config = withProject(devProject({ agent }));
    expect(validateConfig(config).some(e => e.message.includes(messagePart))).toBe(true);
  });

  it('detects remote agent without host config', () => {
    const config = withProject(devProject({ agent: [[makeAgent({ id: 'd1', role: 'dev', mode: 'remote' })]] }));
    expect(validateConfig(config).some(e => e.message.includes('host'))).toBe(true);
  });

  it('accepts remote agent with host config', () => {
    const config = withProject(devProject({
      agent: [[makeAgent({ id: 'd1', role: 'dev', mode: 'remote', host: { hostname: 'server', user: 'rock' } })]],
    }));
    expect(validateConfig(config)).toEqual([]);
  });

  it('detects duplicate project ids', () => {
    const config = makeConfig({
      project: [
        { id: 'same', repo: 'u/r1', merge: null, agent: [[makeAgent({ id: 'd1', role: 'dev' })]] },
        { id: 'same', repo: 'u/r2', merge: null, agent: [[makeAgent({ id: 'd2', role: 'dev' })]] },
      ],
    });
    expect(validateConfig(config).some(e => e.message.includes('Duplicate project id'))).toBe(true);
  });

  it('rejects malformed project.repo (missing owner/repo separator)', () => {
    expect(repoErrors('no-slash').length).toBeGreaterThan(0);
  });

  it('accepts project.repo as a github.com git URL in every supported form', () => {
    const urls = [
      'https://github.com/example-owner/example-repo.git',
      'https://github.com/example-owner/example-repo',
      'git@github.com:example-owner/example-repo.git',
      'git@github.com:example-owner/example-repo',
      'ssh://git@github.com/example-owner/example-repo.git',
    ];
    for (const repo of urls) {
      expect.soft(repoErrors(repo), repo).toEqual([]);
    }
  });

  it('accepts non-github git URLs (https / ssh / scp, including multi-segment subgroup paths)', () => {
    const ok = [
      'https://gitlab.example.com/group/proj.git',
      'git@gitlab.com:group/proj.git',
      'ssh://git@gitlab.example.com:2222/group/sub/proj.git',
      'https://gitlab.example.com/group/sub/deep/proj',
      'https://gitea.internal/team/repo.git',
    ];
    for (const repo of ok) {
      expect.soft(repoErrors(repo), repo).toEqual([]);
    }
  });

  it('rejects github multi-segment paths and non-github paths with unsafe segments', () => {
    const bad = [
      'https://github.com/group/sub/proj.git',
      'https://github.com:443/org/repo.git',
      'https://gitlab.example.com/group/../proj.git',
      'https://gitlab.example.com/group//proj.git',
      'https://gitlab.example.com/.hidden/proj',
      'https://gitlab.example.com/',
    ];
    for (const repo of bad) {
      expect.soft(repoErrors(repo), repo).toHaveLength(1);
    }
  });

  it('rejects non-github repos with an unsafe host (path traversal / command injection)', () => {
    const bad = [
      'https://../group/proj.git',
      'https://gitlab.example.com;touch x/group/proj.git',
      'https://gitlab.example.com$(touch x)/group/proj.git',
      'https://gitlab.example.com`id`/group/proj.git',
      'https://gitlab.example.com|x/group/proj.git',
    ];
    for (const repo of bad) {
      expect.soft(repoErrors(repo), repo).toHaveLength(1);
    }
  });

  it('rejects project.repo with embedded credentials (http(s) userinfo OR ssh secret — must not be stored)', () => {
    for (const repo of [
      'https://oauth2:TOKEN@gitlab.example.com/group/proj.git',
      'https://TOKEN@gitlab.example.com/group/proj.git',
      'ssh://git:TOKEN@gitlab.example.com/group/proj.git',
    ]) {
      const errs = repoErrors(repo);
      expect.soft(errs, repo).toHaveLength(1);
      expect.soft(errs[0]?.message, repo).toMatch(/must not embed credentials/);
    }
  });

  it('allows plain SSH logins (git@), which are not secrets', () => {
    for (const repo of ['ssh://git@gitlab.example.com/group/proj.git', 'git@gitlab.example.com:group/proj.git']) {
      expect.soft(repoErrors(repo), repo).toEqual([]);
    }
  });

  it('accepts a non-github project with a lone dev (no qa) — incremental agent creation not blocked at config time', () => {
    const cfg = withProject(devProject({
      id: 'gl', repo: 'https://gitlab.example.com/group/proj.git',
      review: { mode: 'server' },
      agent: [[makeAgent({ id: 'gldev', role: 'dev' })]],
    }));
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('accepts a non-github project that falls back to global server review mode', () => {
    const cfg = withProject(
      devProject({ id: 'gl', repo: 'https://gitlab.example.com/group/proj.git', agent: [[makeAgent({ id: 'gldev', role: 'dev' })]] }),
      { review: { rounds: 10, mode: 'server' } },
    );
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('rejects a non-github project whose effective review.mode is github', () => {
    const errors = validateConfig(withProject(
      devProject({ id: 'gl', repo: 'https://gitlab.example.com/group/proj.git', agent: [] }),
      { review: { rounds: 10, mode: 'github' } },
    ));
    expect(errors.map(e => e.path)).toContain('project[0].review.mode');
  });

  it('rejects a non-github project overriding global server mode back to github', () => {
    const errors = validateConfig(withProject(
      devProject({ id: 'gl', repo: 'https://gitlab.example.com/group/proj.git', review: { mode: 'github' }, agent: [] }),
      { review: { rounds: 10, mode: 'server' } },
    ));
    expect(errors.map(e => e.path)).toContain('project[0].review.mode');
  });

  it('rejects unknown agent.runtime / role / mode', () => {
    const cfg = withProject(devProject({
      agent: [[{
        id: 'dd', runtime: 'gemini' as never, role: 'reviewer' as never,
        mode: 'cloud' as never, workdir: '/tmp',
      }]],
    }));
    expect(hasPathEndingWith(cfg, '.runtime')).toBe(true);
    expect(hasPathEndingWith(cfg, '.role')).toBe(true);
    expect(hasPathEndingWith(cfg, '.mode')).toBe(true);
  });

  it('rejects empty agent.id and agent.workdir', () => {
    const cfg = withProject(devProject({ agent: [[makeAgent({ id: '', workdir: '   ' })]] }));
    expect(hasPathEndingWith(cfg, '.id')).toBe(true);
    expect(hasPathEndingWith(cfg, '.workdir')).toBe(true);
  });

  it('rejects invalid server.port and review.rounds', () => {
    const cfg = makeConfig({
      server: { ...DEFAULT_SERVER_CONFIG, port: 70000 },
      review: { rounds: 0 },
    });
    expect(paths(cfg)).toContain('server.port');
    expect(paths(cfg)).toContain('review.rounds');
  });

  it('rejects invalid review.mode', () => {
    const errors = validateConfig(makeConfig({ review: { rounds: 10, mode: 'gitlab' as never } }));
    expect(errors.map(e => e.path)).toContain('review.mode');
  });

  it('rejects invalid project.review.mode', () => {
    const errors = validateConfig(withProject(devProject({ review: { mode: 'gitlab' as never }, agent: [] })));
    expect(errors.map(e => e.path)).toContain('project[0].review.mode');
  });

  it('allows a github project to override global server mode back to github', () => {
    const errors = validateConfig(withProject(
      devProject({ review: { mode: 'github' }, agent: [[makeAgent({ id: 'd1', role: 'dev' })]] }),
      { review: { rounds: 10, mode: 'server' } },
    ));
    expect(errors).toEqual([]);
  });

  it('rejects invalid review.afterDone', () => {
    const errors = validateConfig(makeConfig({ review: { rounds: 10, mode: 'server', afterDone: 'tag' as never } }));
    expect(errors.map(e => e.path)).toContain('review.afterDone');
  });

  it('accepts review.mode=server with afterDone=branch', () => {
    const errors = validateConfig(makeConfig({ review: { rounds: 10, mode: 'server', afterDone: 'branch' } }));
    expect(errors.filter(e => e.path.startsWith('review.'))).toEqual([]);
  });

  describe('server.https', () => {
    it('accepts well-formed https config', () => {
      const cfg = withServer({ port: 443, https: { keyFile: '/etc/baxian/ssl/key.pem', certFile: '/etc/baxian/ssl/cert.pem' } });
      expect(validateConfig(cfg)).toEqual([]);
    });

    it('rejects https with empty keyFile or certFile', () => {
      const cfg = withServer({ port: 443, https: { keyFile: '', certFile: '   ' } as never });
      expect(paths(cfg)).toContain('server.https.keyFile');
      expect(paths(cfg)).toContain('server.https.certFile');
    });

    it('rejects relative cert paths (they resolve against process.cwd, which varies between systemd/manual launch)', () => {
      const cfg = withServer({ port: 443, https: { keyFile: 'ssl/key.pem', certFile: 'ssl/cert.pem' } });
      const errors = validateConfig(cfg);
      expect(errors.find(e => e.path === 'server.https.keyFile')?.message).toMatch(/absolute path/);
      expect(errors.find(e => e.path === 'server.https.certFile')?.message).toMatch(/absolute path/);
    });
  });

  describe('server.allowedHosts', () => {
    it.each<[string, string[], string | null]>([
      ['accepts an array of non-empty strings', ['baxian.dev', 'www.baxian.dev'], null],
      ['rejects non-array allowedHosts', 'baxian.dev' as unknown as string[], 'server.allowedHosts'],
      ['rejects empty string entries inside allowedHosts', ['baxian.dev', ''], 'server.allowedHosts[1]'],
    ])('%s', (_label, allowedHosts, expectedPath) => {
      const cfg = withServer({ allowedHosts });
      if (expectedPath === null) {
        expect(validateConfig(cfg)).toEqual([]);
      } else {
        expect(paths(cfg)).toContain(expectedPath);
      }
    });
  });

  it('accepts valid server tmux probe settings', () => {
    const cfg = withServer({ tmuxProbePollIntervalMs: 10000, tmuxProbeTimeoutMs: 3000, tmuxProbeConcurrency: 4 });
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('accepts server.tmuxProbePollIntervalMs at bounds [1000, 2^31-1]', () => {
    for (const ms of [1000, 10_000, 2_147_483_647]) {
      const cfg = withServer({ tmuxProbePollIntervalMs: ms });
      expect(validateConfig(cfg).some(e => e.path === 'server.tmuxProbePollIntervalMs')).toBe(false);
    }
  });

  it('rejects invalid server tmux probe settings', () => {
    for (const ms of [999, 0, -1000, 1500.5, 2_147_483_648]) {
      const cfg = withServer({ tmuxProbePollIntervalMs: ms, tmuxProbeTimeoutMs: -1, tmuxProbeConcurrency: 1.5 });
      const p = paths(cfg);
      expect(p).toContain('server.tmuxProbePollIntervalMs');
      expect(p).toContain('server.tmuxProbeTimeoutMs');
      expect(p).toContain('server.tmuxProbeConcurrency');
    }
  });

  it.each<[string, number[] | null, boolean]>([
    ['rejects non-positive server.bootstrapRetryIntervalMs', [0], true],
    ['rejects non-integer server.bootstrapRetryIntervalMs', [1.5], true],
    ['accepts default server.bootstrapRetryIntervalMs', null, false],
    ['accepts positive integer server.bootstrapRetryIntervalMs', [60_000], false],
    ['accepts server.bootstrapRetryIntervalMs at bounds [1000, 2^31-1]', [1000, 60_000, 2_147_483_647], false],
    ['rejects server.bootstrapRetryIntervalMs below floor or above setInterval ceiling', [999, 2_147_483_648], true],
  ])('%s', (_label, values, rejected) => {
    const samples = values ?? [undefined];
    for (const ms of samples) {
      const cfg = values === null ? makeConfig() : withServer({ bootstrapRetryIntervalMs: ms });
      expect(validateConfig(cfg).some(e => e.path === 'server.bootstrapRetryIntervalMs')).toBe(rejected);
    }
  });

  it.each<[string, number[], boolean]>([
    ['accepts server.githubPollIntervalMs within [1000, 2^31-1]', [1000, 60000, 2147483647], false],
    ['rejects server.githubPollIntervalMs out of [1000, 2^31-1] or non-integer', [500, 0, -1000, 1500.5, 2147483648], true],
  ])('%s', (_label, samples, rejected) => {
    for (const ms of samples) {
      const cfg = withServer({ githubPollIntervalMs: ms });
      expect(validateConfig(cfg).some(e => e.path === 'server.githubPollIntervalMs')).toBe(rejected);
    }
  });

  it('rejects invalid project.merge value', () => {
    const cfg = withProject(devProject({ merge: 'manual' as unknown as MergeStrategy }));
    expect(hasPathEndingWith(cfg, '.merge')).toBe(true);
  });

  it('rejects invalid project.specApproval value', () => {
    const cfg = withProject(devProject({ specApproval: 'qa' as unknown as SpecApprovalStrategy }));
    expect(hasPathEndingWith(cfg, '.specApproval')).toBe(true);
  });

  it.each<[string, SpecApprovalStrategy | undefined]>([
    ['human', 'human'],
    ['null', null],
    ['absent', undefined],
  ])('accepts project.specApproval = %s', (_label, specApproval) => {
    const cfg = withProject(devProject(specApproval === undefined ? {} : { specApproval }));
    expect(hasPathEndingWith(cfg, '.specApproval')).toBe(false);
  });

  it.each<[string, AgentConfig['host'], string | null]>([
    ['rejects remote agent host with empty hostname', { hostname: '' }, 'host.hostname'],
    ['accepts remote agent with hostname only (user omitted)', { hostname: 'box' }, null],
    ['rejects host.user when set to an empty string', { hostname: 'box', user: '   ' }, 'host.user'],
  ])('%s', (_label, host, suffix) => {
    const cfg = withProject(devProject({ agent: [[makeAgent({ id: 'dd', role: 'dev', mode: 'remote', host })]] }));
    if (suffix === null) {
      expect(validateConfig(cfg)).toEqual([]);
    } else {
      expect(hasPathEndingWith(cfg, suffix)).toBe(true);
    }
  });

  it('accepts agent without workdir (auto mode)', () => {
    const config = withProject(devProject({ agent: [[makeAgent({ id: 'd1', role: 'dev', workdir: undefined })]] }));
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects agent with empty-string workdir', () => {
    const config = withProject(devProject({ agent: [[makeAgent({ id: 'd1', role: 'dev', workdir: '' })]] }));
    expect(hasPathEndingWith(config, '.workdir')).toBe(true);
  });

  it('rejects project.repo with shell metacharacters', () => {
    const cases = [
      'foo/bar;rm',
      'foo/bar`echo`',
      'foo/bar$(x)',
      'foo/bar&&x',
      'foo/bar|x',
      'foo/bar"x',
      "foo/bar'x",
    ];
    for (const repo of cases) {
      expect(repoErrors(repo).length).toBeGreaterThan(0);
    }
  });

  it('accepts valid GitHub-style repo names', () => {
    const cases = [
      'owner/repo',
      'owner-1/repo_2',
      'a.b/c.d',
      'A_B/C-D',
    ];
    for (const repo of cases) {
      expect(repoErrors(repo)).toEqual([]);
    }
  });

  it('rejects project.repo with path-traversal segments', () => {
    const cases = [
      '../etc',
      'foo/..',
      './x',
      'foo/.',
      '.foo/bar',
      'foo/.bar',
      '../../etc',
    ];
    for (const repo of cases) {
      expect(repoErrors(repo).length).toBeGreaterThan(0);
    }
  });
});

describe('agent.yolo field', () => {
  it('accepts yolo: true', () => {
    const config = withProject(devProject({ agent: [[makeAgent({ id: 'dd', role: 'dev', yolo: true })]] }));
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects yolo: false (interactive REPL only supports YOLO/bypass)', () => {
    const config = withProject(devProject({ agent: [[makeAgent({ id: 'dd', role: 'dev', yolo: false })]] }));
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.includes('yolo') && /yolo=false is rejected/.test(e.message))).toBe(true);
  });

  it('rejects non-boolean yolo', () => {
    const config = withProject(devProject({
      agent: [[makeAgent({ id: 'dd', role: 'dev', yolo: 'true' as unknown as boolean })]],
    }));
    expect(validateConfig(config).some(e => e.path.includes('yolo'))).toBe(true);
  });
});

describe('agent.model field', () => {
  it.each([
    ['accepts non-empty model string', 'sonnet', true],
    ['rejects empty-string model', '   ', false],
    ['rejects non-string model', 42 as unknown as string, false],
  ] as const)('%s', (_label, model, valid) => {
    const config = withProject(devProject({ agent: [[makeAgent({ id: 'dd', role: 'dev', model })]] }));
    if (valid) {
      expect(validateConfig(config)).toEqual([]);
    } else {
      expect(hasPathEndingWith(config, '.model')).toBe(true);
    }
  });
});

describe('agent.addDirs field', () => {
  type AddDirsCheck = (config: BaxianConfig) => void;
  const valid: AddDirsCheck = (config) => { expect(validateConfig(config)).toEqual([]); };

  it.each<[string, string[], AddDirsCheck]>([
    ['accepts empty addDirs array', [], valid],
    ['accepts addDirs of non-empty strings', ['/a/b', '/c/d'], valid],
    ['rejects addDirs containing empty string', ['/a/b', '   '], (config) => {
      expect(validateConfig(config).some(e => /\.addDirs\[1\]$/.test(e.path))).toBe(true);
    }],
    ['rejects non-array addDirs', '/a/b' as unknown as string[], (config) => {
      expect(hasPathEndingWith(config, '.addDirs')).toBe(true);
    }],
  ])('%s', (_label, addDirs, check) => {
    check(withProject(devProject({ agent: [[makeAgent({ id: 'dd', role: 'dev', addDirs })]] })));
  });
});

describe('project.agent empty array', () => {
  it('accepts empty agent array', () => {
    expect(validateConfig(withProject(devProject({ agent: [] })))).toEqual([]);
  });

  it('still rejects non-array agent field', () => {
    const config = withProject(devProject({ agent: 'not-an-array' as unknown as AgentConfig[][] }));
    expect(validateConfig(config).some(e => e.path.includes('agent'))).toBe(true);
  });
});

describe('id format validation', () => {
  it.each([
    ['rejects project.id with uppercase', 'BadID', false],
    ['rejects project.id with special chars', '../etc/passwd', false],
    ['rejects project.id with leading dash', '-leading', false],
    ['accepts well-formed ids', 'kk-cc', true],
  ] as const)('%s', (_label, id, valid) => {
    const config = withProject({ id, repo: 'a/b', merge: null, agent: [] });
    if (valid) {
      expect(validateConfig(config)).toEqual([]);
    } else {
      expect(validateConfig(config).some(e => e.path.includes('id'))).toBe(true);
    }
  });

  it('rejects agent.id with bad format', () => {
    const config = withProject({
      id: 'p1', repo: 'a/b', merge: null,
      agent: [[makeAgent({ id: 'BAD', role: 'dev' })]],
    });
    expect(validateConfig(config).some(e => e.path.includes('agent') && e.path.includes('id'))).toBe(true);
  });
});

describe('validateConfig: empty / non-array project list', () => {
  it('accepts project: [] (zero-config first run before user creates anything via UI)', () => {
    const config = makeConfig({ project: [] });
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects project being non-array (malformed shape, not "no projects")', () => {
    const config = makeConfig({ project: 'oops' as unknown as BaxianConfig['project'] });
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('project');
    expect(errors[0].message).toMatch(/array/);
  });
});

describe('validateHosts (host registry)', () => {
  type HostList = NonNullable<BaxianConfig['host']>;
  type HostCheck = (config: BaxianConfig) => void;
  const hasPath = (path: string): HostCheck => (config) =>
    expect(validateConfig(config).some(e => e.path === path)).toBe(true);

  it.each<[string, HostList, HostCheck]>([
    ['accepts a well-formed registry', [{ id: 'box', hostname: 'h.example.com', port: 22, user: 'u' }],
      (config) => { expect(validateConfig(config)).toEqual([]); }],
    ['rejects a host missing an id', [{ hostname: 'h' } as never], hasPath('host[0].id')],
    ['rejects duplicate host ids', [{ id: 'box', hostname: 'h1' }, { id: 'box', hostname: 'h2' }],
      (config) => { expect(validateConfig(config).some(e => /Duplicate host id/.test(e.message))).toBe(true); }],
    ['rejects a host missing a hostname', [{ id: 'box', hostname: '' }], hasPath('host[0].hostname')],
    ['rejects a port out of range', [{ id: 'box', hostname: 'h', port: 70000 }], hasPath('host[0].port')],
  ])('%s', (_label, host, check) => {
    check(makeConfig({ host }));
  });
});

describe('remote agent host references', () => {
  type HostCheck = (config: BaxianConfig) => void;
  const accepts: HostCheck = (config) => { expect(validateConfig(config)).toEqual([]); };
  const message = (re: RegExp): HostCheck => (config) =>
    expect(validateConfig(config).some(e => re.test(e.message))).toBe(true);
  const path = (p: string): HostCheck => (config) =>
    expect(validateConfig(config).some(e => e.path === p)).toBe(true);
  const noThrowPath = (p: string): HostCheck => (config) => {
    expect(() => validateConfig(config)).not.toThrow();
    expect(validateConfig(config).some(e => e.path === p)).toBe(true);
  };
  const noThrowMessage = (re: RegExp): HostCheck => (config) => {
    expect(() => validateConfig(config)).not.toThrow();
    message(re)(config);
  };

  function remoteHostConfig(host: AgentConfig['host'], rest: Partial<BaxianConfig> = {}): BaxianConfig {
    return withProject(
      { id: 'proj', repo: 'u/r', merge: null, agent: [[makeAgent({ id: 'rdev', role: 'dev', mode: 'remote', host, workdir: undefined })]] },
      rest,
    );
  }

  it.each<[string, AgentConfig['host'], Partial<BaxianConfig>, HostCheck]>([
    ['accepts a remote agent referencing an existing host id', 'box', { host: [{ id: 'box', hostname: 'h', user: 'u' }] }, accepts],
    ['rejects a remote agent referencing an unknown host id', 'ghost', { host: [] }, message(/unknown host id/)],
    ['still accepts a legacy inline host object', { hostname: 'legacy', user: 'old' }, {}, accepts],
    ['rejects an inline host carrying a password (secrets belong in the registry)', { hostname: 'legacy', password: 'x' } as never, {}, message(/must not carry a password/)],
    ['rejects a legacy inline host with an out-of-range port (interpolated into ssh)', { hostname: 'legacy', port: 70000 } as never, {}, path('project.proj.agent.rdev.host.port')],
    ['treats a null agent.host as missing (clean error, not a TypeError/500)', null as never, {}, noThrowMessage(/must reference a host/)],
    ['rejects a non-string, non-object agent.host (e.g. number) cleanly', 42 as never, {}, noThrowPath('project.proj.agent.rdev.host')],
  ])('%s', (_label, host, rest, check) => {
    check(remoteHostConfig(host, rest));
  });
});
