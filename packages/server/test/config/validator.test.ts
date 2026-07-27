import { describe, it, expect } from 'vitest';
import { userInfo } from 'node:os';
import { validateConfig } from '../../src/config/validator.js';
import type { BaxianConfig, AgentConfig, ProjectConfig, MergeStrategy, SpecApprovalStrategy } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const id = overrides.id ?? 'dev-1';
  return {
    id,
    runtime: 'claude-code',
    role: 'dev',
    mode: 'local',
    workdir: `/tmp/${id}`,
    yolo: false,
    ...overrides,
  };
}

function makeAgentGroup(
  devOverrides: Partial<AgentConfig> = {},
  qaOverrides: Partial<AgentConfig> = {},
): [AgentConfig, AgentConfig] {
  return [
    makeAgent({ id: 'dd', role: 'dev', ...devOverrides }),
    makeAgent({ id: 'qq', role: 'qa', runtime: 'codex', ...qaOverrides }),
  ];
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
    agent: [makeAgentGroup()],
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
  return validateConfig(withProject(
    devProject({
      repo,
      ...(repo.includes('github.com') || /^[^/:]+\/[^/]+$/.test(repo)
        ? {}
        : { gitCli: { tool: 'glab' } }),
    }),
  )).filter(e => e.path.endsWith('.repo'));
}

describe('validateConfig', () => {
  it('returns empty array for valid config', () => {
    expect(validateConfig(makeConfig())).toEqual([]);
  });

  it('rejects an incomplete group without QA', () => {
    const config = withProject(devProject({ id: 'pp', agent: [[makeAgent({ id: 'd1', role: 'dev' })]] }));
    expect(validateConfig(config)).toContainEqual({
      path: 'project.pp.agent[0]',
      message: 'Agent group must contain exactly one qa agent',
    });
  });

  it('detects duplicate agent ids across projects', () => {
    const config = makeConfig({
      project: [
        { id: 'p1', repo: 'u/r1', merge: null, agent: [makeAgentGroup({ id: 'dup' }, { id: 'q1' })] },
        { id: 'p2', repo: 'u/r2', merge: null, agent: [makeAgentGroup({ id: 'dup' }, { id: 'q2' })] },
      ],
    });
    const errors = validateConfig(config);
    expect(errors.filter(error => error.message.includes('Duplicate agent id'))).toHaveLength(1);
  });

  it('detects duplicate agent ids within same project', () => {
    const config = withProject(devProject({
      agent: [
        makeAgentGroup({ id: 'dup' }, { id: 'q1' }),
        makeAgentGroup({ id: 'dup' }, { id: 'q2' }),
      ],
    }));
    const errors = validateConfig(config);
    expect(errors.some(e => e.message.includes('Duplicate'))).toBe(true);
  });

  it('accepts a dev and qa group in any order', () => {
    const config = withProject(devProject({ agent: [[
      makeAgent({ id: 'q1', role: 'qa' }),
      makeAgent({ id: 'd1', role: 'dev' }),
    ]] }));
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects the research role and lists the current role enum', () => {
    const research = makeAgent({ id: 'r1' });
    (research as { role: string }).role = 'research';
    const errors = validateConfig(withProject(devProject({ agent: [[
      makeAgent({ id: 'd1', role: 'dev' }),
      research,
    ]] })));
    expect(errors).toContainEqual(expect.objectContaining({
      message: expect.stringMatching(/dev.*qa/),
    }));
  });

  it.each<[string, AgentConfig[][], string]>([
    ['detects a group without dev', [[makeAgent({ id: 'q1', role: 'qa' })]], 'exactly one dev'],
    ['detects multiple dev agents', [[
      makeAgent({ id: 'd1', role: 'dev' }),
      makeAgent({ id: 'd2', role: 'dev' }),
    ]], 'exactly one dev'],
    ['detects more than 2 agents in a group', [[
      makeAgent({ id: 'd1', role: 'dev' }),
      makeAgent({ id: 'q1', role: 'qa' }),
      makeAgent({ id: 'q2', role: 'qa' }),
    ]], 'at most 2'],
    ['detects duplicate qa agents', [[
      makeAgent({ id: 'd1', role: 'dev' }),
      makeAgent({ id: 'q1', role: 'qa' }),
      makeAgent({ id: 'q2', role: 'qa' }),
    ]], 'exactly one qa'],
    ['detects empty agent group', [[]], 'empty'],
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
      agent: [makeAgentGroup({
        id: 'd1',
        mode: 'remote',
        host: { hostname: 'server', user: 'rock' },
      })],
    }));
    expect(validateConfig(config)).toEqual([]);
  });

  it('detects duplicate project ids', () => {
    const config = makeConfig({
      project: [
        { id: 'same', repo: 'u/r1', merge: null, agent: [makeAgentGroup({ id: 'd1' }, { id: 'q1' })] },
        { id: 'same', repo: 'u/r2', merge: null, agent: [makeAgentGroup({ id: 'd2' }, { id: 'q2' })] },
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

  it('accepts non-github http(s) git URLs, including multi-segment subgroup paths', () => {
    const ok = [
      'https://gitlab.example.com/group/proj.git',
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
      expect.soft(repoErrors(repo).length, repo).toBeGreaterThan(0);
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
      expect.soft(repoErrors(repo).length, repo).toBeGreaterThan(0);
    }
  });

  it('rejects project.repo with embedded credentials (http(s) userinfo OR ssh secret — must not be stored)', () => {
    for (const repo of [
      'https://oauth2:TOKEN@gitlab.example.com/group/proj.git',
      'https://TOKEN@gitlab.example.com/group/proj.git',
      'ssh://git:TOKEN@gitlab.example.com/group/proj.git',
    ]) {
      const errs = repoErrors(repo);
      expect.soft(errs.some(error => /must not embed credentials/.test(error.message)), repo).toBe(true);
    }
  });

  it('rejects non-github SSH and scp URLs because the platform driver needs an HTTP API endpoint', () => {
    for (const repo of ['ssh://git@gitlab.example.com/group/proj.git', 'git@gitlab.example.com:group/proj.git']) {
      expect.soft(
        repoErrors(repo).some(error => /require an http\(s\):\/\//.test(error.message)),
        repo,
      ).toBe(true);
    }
  });

  it('accepts a non-github project with a complete agent group', () => {
    const cfg = withProject(devProject({
      id: 'gl', repo: 'https://gitlab.example.com/group/proj.git',
      gitCli: { tool: 'glab' },
      agent: [makeAgentGroup({ id: 'gldev' }, { id: 'glqa' })],
    }));
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('requires an explicit gitCli driver for a non-github project', () => {
    const errors = validateConfig(withProject(devProject({
      id: 'gl',
      repo: 'https://gitlab.example.com/group/proj.git',
      agent: [makeAgentGroup({ id: 'gldev' }, { id: 'glqa' })],
    })));
    expect(errors).toContainEqual(expect.objectContaining({
      path: 'project[0].gitCli',
      message: expect.stringContaining('require gitCli.tool'),
    }));
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
    const cfg = withProject(devProject({
      agent: [makeAgentGroup({ id: 'dd', mode: 'remote', host })],
    }));
    if (suffix === null) {
      expect(validateConfig(cfg)).toEqual([]);
    } else {
      expect(hasPathEndingWith(cfg, suffix)).toBe(true);
    }
  });

  it('accepts agent without workdir (auto mode)', () => {
    const config = withProject(devProject({
      agent: [makeAgentGroup({ id: 'd1', workdir: undefined })],
    }));
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects agent with empty-string workdir', () => {
    const config = withProject(devProject({ agent: [[makeAgent({ id: 'd1', role: 'dev', workdir: '' })]] }));
    expect(hasPathEndingWith(config, '.workdir')).toBe(true);
  });

  it('rejects two agents that resolve to the same Workdir on one host', () => {
    const config = withProject(devProject({
      agent: [[
        makeAgent({ id: 'd1', role: 'dev', workdir: '/tmp/shared/../agent' }),
        makeAgent({ id: 'q1', role: 'qa', workdir: '/tmp/agent' }),
      ]],
    }));

    const error = validateConfig(config).find(item => item.path.endsWith('[1].workdir'));
    expect(error?.message).toContain('must not share a directory');
  });

  it('allows equal Workdir paths on different remote hosts', () => {
    const config = withProject(devProject({
      agent: [[
        makeAgent({
          id: 'd1', role: 'dev', mode: 'remote', workdir: '/srv/baxian/agent',
          host: { hostname: 'dev.example.com', user: 'git' },
        }),
        makeAgent({
          id: 'q1', role: 'qa', mode: 'remote', workdir: '/srv/baxian/agent',
          host: { hostname: 'qa.example.com', user: 'git' },
        }),
      ]],
    }));

    expect(validateConfig(config)).toEqual([]);
  });

  it('treats an omitted SSH port and explicit port 22 as the same Workdir host', () => {
    const config = withProject(devProject({
      agent: [[
        makeAgent({
          id: 'd1', role: 'dev', mode: 'remote', workdir: '/srv/baxian/agent',
          host: { hostname: 'box.example.com', user: 'git' },
        }),
        makeAgent({
          id: 'q1', role: 'qa', mode: 'remote', workdir: '/srv/baxian/agent',
          host: { hostname: 'box.example.com', user: 'git', port: 22 },
        }),
      ]],
    }));

    const error = validateConfig(config).find(item => item.path.endsWith('[1].workdir'));
    expect(error?.message).toContain('must not share a directory');
  });

  it('rejects equal Workdir paths on the same host and account despite distinct SSH ports', () => {
    const config = withProject(devProject({
      agent: [[
        makeAgent({
          id: 'd1', role: 'dev', mode: 'remote', workdir: '/srv/baxian/agent',
          host: { hostname: 'box.example.com', user: 'git', port: 22 },
        }),
        makeAgent({
          id: 'q1', role: 'qa', mode: 'remote', workdir: '/srv/baxian/agent',
          host: { hostname: 'box.example.com', user: 'git', port: 2222 },
        }),
      ]],
    }));

    const error = validateConfig(config).find(item => item.path.endsWith('[1].workdir'));
    expect(error?.message).toContain('must not share a directory');
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

describe('root agent config', () => {
  it('accepts one local root agent scoped to a known project', () => {
    const config = makeConfig({
      root: {
        runtime: 'codex',
        mode: 'local',
        workdir: '/tmp/root-agent',
        projects: ['proj'],
        responseTimeoutMinutes: 15,
      },
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('reserves root-agent even before root recovery is configured', () => {
    const config = makeConfig({
      project: [{
        id: 'proj', repo: 'user/repo', merge: null,
        agent: [[makeAgent({ id: 'root-agent', role: 'dev' })]],
      }],
    });
    expect(validateConfig(config).some(error => error.message.includes('reserved for the root agent'))).toBe(true);
  });

  it('rejects reserved ids, shared workdirs, and an empty project scope', () => {
    const config = makeConfig({
      root: {
        runtime: 'codex',
        mode: 'local',
        workdir: '/tmp/root-agent',
        projects: [],
        responseTimeoutMinutes: 15,
      },
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [[makeAgent({ id: 'root-agent', role: 'dev', workdir: '/tmp/root-agent' })]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(error => error.message.includes('reserved for the root agent'))).toBe(true);
    expect(errors.some(error => error.message.includes('Workdir is already used by agent "root-agent"'))).toBe(true);
    expect(errors).toContainEqual({
      path: 'root.projects',
      message: 'root.projects must contain at least one project id',
    });
  });

  it('normalizes remote hostname case without collapsing distinct users', () => {
    const configForUser = (user: string) => makeConfig({
      root: {
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'Host.EXAMPLE.com', user: 'agent' },
        workdir: '/srv/shared',
        responseTimeoutMinutes: 15,
      },
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [[makeAgent({
          id: 'dev-1',
          role: 'dev',
          mode: 'remote',
          host: { hostname: 'host.example.com', user },
          workdir: '/srv/shared',
        })]],
      }],
    });

    expect(validateConfig(configForUser('agent')).some(error =>
      error.message.includes('Workdir is already used by agent "root-agent"'),
    )).toBe(true);
    expect(validateConfig(configForUser('other-user')).some(error =>
      error.message.includes('Workdir is already used'),
    )).toBe(false);
  });

  it('rejects a local root and loopback SSH peer sharing one Workdir', () => {
    const config = makeConfig({
      root: {
        runtime: 'codex',
        mode: 'local',
        workdir: '/tmp/shared-root-workdir',
        responseTimeoutMinutes: 15,
      },
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [[makeAgent({
          id: 'dev-loopback',
          role: 'dev',
          mode: 'remote',
          host: { hostname: '127.0.0.1', user: userInfo().username, port: 22 },
          workdir: '/tmp/shared-root-workdir',
          yolo: false,
        })]],
      }],
    });

    expect(validateConfig(config).some(error =>
      error.message.includes('Workdir is already used by agent "root-agent"'),
    )).toBe(true);
  });

  it('rejects a same-account yolo agent even when its Workdir is separate', () => {
    const config = makeConfig({
      root: {
        runtime: 'codex',
        mode: 'local',
        workdir: '/tmp/root-agent',
        responseTimeoutMinutes: 15,
      },
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [[makeAgent({ id: 'dev-yolo', role: 'dev', workdir: '/tmp/dev-yolo', yolo: true })]],
      }],
    });

    expect(validateConfig(config)).toContainEqual({
      path: 'project.proj.agent.dev-yolo.yolo',
      message: expect.stringContaining('may share the root mailbox OS account'),
    });
  });

  it('treats an implicit SSH user as potentially matching an explicit peer user', () => {
    const config = makeConfig({
      root: {
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'Host.EXAMPLE.com' },
        workdir: '/srv/root',
        responseTimeoutMinutes: 15,
      },
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [[makeAgent({
          id: 'dev-yolo',
          role: 'dev',
          mode: 'remote',
          host: { hostname: 'host.example.com', user: 'runner' },
          workdir: '/srv/dev',
          yolo: true,
        })]],
      }],
    });

    expect(validateConfig(config).some(error =>
      error.path === 'project.proj.agent.dev-yolo.yolo',
    )).toBe(true);
  });

  it('allows a yolo peer when a different remote account is explicit', () => {
    const config = makeConfig({
      root: {
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'host.example.com', user: 'root', port: 22 },
        workdir: '/srv/root',
        responseTimeoutMinutes: 15,
      },
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [makeAgentGroup({
          id: 'dev-yolo',
          mode: 'remote',
          host: { hostname: 'host.example.com', user: 'runner', port: 22 },
          workdir: '/srv/dev',
          yolo: true,
        })],
      }],
    });

    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects a yolo peer on the same host and account despite a distinct SSH port', () => {
    const config = makeConfig({
      root: {
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'host.example.com', user: 'runner', port: 22 },
        workdir: '/srv/root',
        responseTimeoutMinutes: 15,
      },
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [[makeAgent({
          id: 'dev-yolo',
          role: 'dev',
          mode: 'remote',
          host: { hostname: 'host.example.com', user: 'runner', port: 2222 },
          workdir: '/srv/dev',
          yolo: true,
        })]],
      }],
    });

    expect(validateConfig(config)).toContainEqual({
      path: 'project.proj.agent.dev-yolo.yolo',
      message: expect.stringContaining('may share the root mailbox OS account'),
    });
  });

  it('reports malformed inline hosts instead of throwing during account checks', () => {
    const config = makeConfig({
      root: {
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: '', port: 70_000 } as never,
        workdir: '/srv/root',
        responseTimeoutMinutes: 15,
      },
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [[makeAgent({
          id: 'dev-yolo',
          role: 'dev',
          mode: 'remote',
          host: { hostname: 'host.example.com', user: 'runner' },
          workdir: '/srv/dev',
          yolo: true,
        })]],
      }],
    });

    expect(() => validateConfig(config)).not.toThrow();
    expect(validateConfig(config)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'root.host.hostname' }),
      expect.objectContaining({ path: 'root.host.port' }),
    ]));
  });

  it('rejects a local-root yolo peer that SSHes back to the same local account', () => {
    const config = makeConfig({
      root: {
        runtime: 'codex',
        mode: 'local',
        workdir: '/tmp/root-agent',
        responseTimeoutMinutes: 15,
      },
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [[makeAgent({
          id: 'dev-yolo',
          role: 'dev',
          mode: 'remote',
          host: { hostname: 'localhost', user: userInfo().username },
          workdir: '/tmp/dev-yolo',
          yolo: true,
        })]],
      }],
    });

    expect(validateConfig(config)).toContainEqual({
      path: 'project.proj.agent.dev-yolo.yolo',
      message: expect.stringContaining('may share the root mailbox OS account'),
    });
  });

  it('applies the same endpoint/account relation to Workdir uniqueness', () => {
    const config = makeConfig({
      root: {
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'host.example.com', port: 22 },
        workdir: '/srv/shared',
        responseTimeoutMinutes: 15,
      },
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [[makeAgent({
          id: 'dev-1',
          role: 'dev',
          mode: 'remote',
          host: { hostname: 'HOST.EXAMPLE.COM', user: 'runner' },
          workdir: '/srv/shared',
        })]],
      }],
    });

    expect(validateConfig(config).some(error =>
      error.message.includes('Workdir is already used by agent "root-agent"'),
    )).toBe(true);
  });

  it('requires a registered host for remote root and rejects inline passwords', () => {
    const unknown = makeConfig({
      root: {
        runtime: 'codex', mode: 'remote', host: 'ghost', workdir: '/srv/root', responseTimeoutMinutes: 15,
      },
    });
    expect(validateConfig(unknown).some(error => /unknown host id/.test(error.message))).toBe(true);

    const inlineSecret = makeConfig({
      root: {
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'host.example', password: 'secret' },
        workdir: '/srv/root',
        responseTimeoutMinutes: 15,
      },
    });
    expect(validateConfig(inlineSecret).some(error => /must not carry a password/.test(error.message))).toBe(true);
  });

  it('rejects the filesystem root as the root agent workdir', () => {
    const config = makeConfig({
      root: {
        runtime: 'codex', mode: 'local', workdir: '/', responseTimeoutMinutes: 15,
      },
    });
    expect(validateConfig(config)).toContainEqual({
      path: 'root.workdir',
      message: 'root.workdir must not be the filesystem root',
    });
  });
});

describe('agent.yolo field', () => {
  it('accepts yolo: true', () => {
    const config = withProject(devProject({ agent: [makeAgentGroup({ yolo: true })] }));
    expect(validateConfig(config)).toEqual([]);
  });

  it('accepts yolo: false (issue #475: runtime launches in its default permission mode)', () => {
    const config = withProject(devProject({ agent: [makeAgentGroup({ yolo: false })] }));
    expect(validateConfig(config)).toEqual([]);
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
    const config = withProject(devProject({ agent: [makeAgentGroup({ model })] }));
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
    check(withProject(devProject({ agent: [makeAgentGroup({ addDirs })] })));
  });
});

describe('opencode/qodercli runtime', () => {
  it('rejects addDirs on an opencode agent (opencode has no --add-dir)', () => {
    const cfg = withProject(devProject({ agent: [[makeAgent({ id: 'dd', role: 'dev', runtime: 'opencode', addDirs: ['/a'] })]] }));
    expect(validateConfig(cfg).some(e => /\.addDirs$/.test(e.path))).toBe(true);
  });

  it('accepts an opencode agent without addDirs', () => {
    const cfg = withProject(devProject({ agent: [makeAgentGroup({ runtime: 'opencode' })] }));
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('accepts a qodercli agent with addDirs', () => {
    const cfg = withProject(devProject({
      agent: [makeAgentGroup({ runtime: 'qodercli', addDirs: ['/a'] })],
    }));
    expect(validateConfig(cfg)).toEqual([]);
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
      {
        id: 'proj',
        repo: 'u/r',
        merge: null,
        agent: [makeAgentGroup({ id: 'rdev', mode: 'remote', host, workdir: undefined })],
      },
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

describe('language', () => {
  it('accepts zh-CN, en-US, and absent language', () => {
    for (const language of ['zh-CN', 'en-US', undefined]) {
      const config = makeConfig();
      if (language !== undefined) (config as Record<string, unknown>).language = language;
      expect(validateConfig(config)).toEqual([]);
    }
  });

  it('rejects invalid language values with a clear path and message', () => {
    for (const bad of ['zh-cn', 'fr-FR', 123, null]) {
      const config = makeConfig();
      (config as Record<string, unknown>).language = bad;
      const errors = validateConfig(config);
      expect(errors).toContainEqual({
        path: 'language',
        message: "language must be 'zh-CN' or 'en-US'",
      });
    }
  });
});
