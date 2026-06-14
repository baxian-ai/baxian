import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/config/validator.js';
import type { BaxianConfig, AgentConfig, MergeStrategy } from '../../src/shared/index.js';

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
    server: { port: 3000 },
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

describe('validateConfig', () => {
  it('returns empty array for valid config', () => {
    expect(validateConfig(makeConfig())).toEqual([]);
  });

  it('accepts dev-only pair (no QA)', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'd1', role: 'dev' })]],
      }],
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('detects duplicate agent ids across projects', () => {
    const config = makeConfig({
      project: [
        {
          id: 'p1', repo: 'u/r1', merge: null,
          agent: [[makeAgent({ id: 'dup', role: 'dev' })]],
        },
        {
          id: 'p2', repo: 'u/r2', merge: null,
          agent: [[makeAgent({ id: 'dup', role: 'dev' })]],
        },
      ],
    });
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Duplicate agent id');
  });

  it('detects duplicate agent ids within same project', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [
          [makeAgent({ id: 'dup', role: 'dev' })],
          [makeAgent({ id: 'dup', role: 'dev' })],
        ],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.message.includes('Duplicate'))).toBe(true);
  });

  it('detects first agent in pair not being dev', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'q1', role: 'qa' })]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.message.includes('first'))).toBe(true);
  });

  it('detects second agent in pair not being qa', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[
          makeAgent({ id: 'd1', role: 'dev' }),
          makeAgent({ id: 'd2', role: 'dev' }),
        ]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.message.includes('second'))).toBe(true);
  });

  it('detects more than 2 agents in a pair', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[
          makeAgent({ id: 'd1', role: 'dev' }),
          makeAgent({ id: 'q1', role: 'qa' }),
          makeAgent({ id: 'q2', role: 'qa' }),
        ]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.message.includes('at most 2'))).toBe(true);
  });

  it('detects empty agent pair', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.message.includes('empty'))).toBe(true);
  });

  it('detects remote agent without host config', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'd1', role: 'dev', mode: 'remote' })]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.message.includes('host'))).toBe(true);
  });

  it('accepts remote agent with host config', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({
          id: 'd1', role: 'dev', mode: 'remote',
          host: { hostname: 'server', user: 'rock' },
        })]],
      }],
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('detects duplicate project ids', () => {
    const config = makeConfig({
      project: [
        { id: 'same', repo: 'u/r1', merge: null, agent: [[makeAgent({ id: 'd1', role: 'dev' })]] },
        { id: 'same', repo: 'u/r2', merge: null, agent: [[makeAgent({ id: 'd2', role: 'dev' })]] },
      ],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.message.includes('Duplicate project id'))).toBe(true);
  });

  it('rejects malformed project.repo (missing owner/repo separator)', () => {
    const cfg = makeConfig({
      project: [{ id: 'pp', repo: 'no-slash', merge: null, agent: [[makeAgent({ id: 'dd', role: 'dev' })]] }],
    });
    expect(validateConfig(cfg).some(e => e.path.endsWith('.repo'))).toBe(true);
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
      const cfg = makeConfig({
        project: [{ id: 'pp', repo, merge: null, agent: [[makeAgent({ id: 'dd', role: 'dev' })]] }],
      });
      expect.soft(validateConfig(cfg).filter(e => e.path.endsWith('.repo')), repo).toEqual([]);
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
      const cfg = makeConfig({
        project: [{ id: 'pp', repo, merge: null, agent: [[makeAgent({ id: 'dd', role: 'dev' })]] }],
      });
      expect.soft(validateConfig(cfg).filter(e => e.path.endsWith('.repo')), repo).toEqual([]);
    }
  });

  it('rejects github multi-segment paths and non-github paths with unsafe segments', () => {
    const bad = [
      'https://github.com/group/sub/proj.git',          // github keeps the owner/repo single-segment rule
      'https://github.com:443/org/repo.git',            // ported github → rejected, not routed to server mode
      'https://gitlab.example.com/group/../proj.git',
      'https://gitlab.example.com/group//proj.git',
      'https://gitlab.example.com/.hidden/proj',
      'https://gitlab.example.com/',
    ];
    for (const repo of bad) {
      const cfg = makeConfig({
        project: [{ id: 'pp', repo, merge: null, agent: [[makeAgent({ id: 'dd', role: 'dev' })]] }],
      });
      expect.soft(validateConfig(cfg).filter(e => e.path.endsWith('.repo')), repo).toHaveLength(1);
    }
  });

  it('rejects non-github repos with an unsafe host (path traversal / command injection)', () => {
    const bad = [
      'https://../group/proj.git',                          // host ".." → traversal out of repos-ext
      'https://gitlab.example.com;touch x/group/proj.git',  // shell metachar → preflight injection
      'https://gitlab.example.com$(touch x)/group/proj.git',
      'https://gitlab.example.com`id`/group/proj.git',
      'https://gitlab.example.com|x/group/proj.git',
    ];
    for (const repo of bad) {
      const cfg = makeConfig({
        project: [{ id: 'pp', repo, merge: null, agent: [[makeAgent({ id: 'dd', role: 'dev' })]] }],
      });
      expect.soft(validateConfig(cfg).filter(e => e.path.endsWith('.repo')), repo).toHaveLength(1);
    }
  });

  it('rejects project.repo with embedded credentials (http(s) userinfo OR ssh secret — must not be stored)', () => {
    for (const repo of [
      'https://oauth2:TOKEN@gitlab.example.com/group/proj.git',
      'https://TOKEN@gitlab.example.com/group/proj.git',
      'ssh://git:TOKEN@gitlab.example.com/group/proj.git',
    ]) {
      const cfg = makeConfig({
        project: [{ id: 'pp', repo, merge: null, agent: [[makeAgent({ id: 'dd', role: 'dev' })]] }],
      });
      const errs = validateConfig(cfg).filter(e => e.path.endsWith('.repo'));
      expect.soft(errs, repo).toHaveLength(1);
      expect.soft(errs[0]?.message, repo).toMatch(/must not embed credentials/);
    }
  });

  it('allows plain SSH logins (git@), which are not secrets', () => {
    for (const repo of ['ssh://git@gitlab.example.com/group/proj.git', 'git@gitlab.example.com:group/proj.git']) {
      const cfg = makeConfig({
        project: [{ id: 'pp', repo, merge: null, agent: [[makeAgent({ id: 'dd', role: 'dev' })]] }],
      });
      expect.soft(validateConfig(cfg).filter(e => e.path.endsWith('.repo')), repo).toEqual([]);
    }
  });

  it('accepts a non-github project with a lone dev (no qa) — incremental agent creation not blocked at config time', () => {
    // Non-github is server-forced at runtime (effectiveReviewMode), but the "server needs qa"
    // invariant is enforced at dispatch, not config — so the Web/API add-dev-then-add-qa flow works.
    const cfg = makeConfig({
      project: [{
        id: 'gl', repo: 'https://gitlab.example.com/group/proj.git', merge: null,
        agent: [[makeAgent({ id: 'gldev', role: 'dev' })]],
      }],
    });
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('rejects unknown agent.runtime / role / mode', () => {
    const cfg = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[{
          id: 'dd', runtime: 'gemini' as never, role: 'reviewer' as never,
          mode: 'cloud' as never, workdir: '/tmp',
        }]],
      }],
    });
    const paths = validateConfig(cfg).map(e => e.path);
    expect(paths.some(p => p.endsWith('.runtime'))).toBe(true);
    expect(paths.some(p => p.endsWith('.role'))).toBe(true);
    expect(paths.some(p => p.endsWith('.mode'))).toBe(true);
  });

  it('rejects empty agent.id and agent.workdir', () => {
    const cfg = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: '', workdir: '   ' })]],
      }],
    });
    const paths = validateConfig(cfg).map(e => e.path);
    expect(paths.some(p => p.endsWith('.id'))).toBe(true);
    expect(paths.some(p => p.endsWith('.workdir'))).toBe(true);
  });

  it('rejects invalid server.port and review.rounds', () => {
    const cfg = makeConfig({
      server: { port: 70000 },
      review: { rounds: 0 },
    });
    const paths = validateConfig(cfg).map(e => e.path);
    expect(paths).toContain('server.port');
    expect(paths).toContain('review.rounds');
  });

  it('rejects invalid review.mode', () => {
    const errors = validateConfig(makeConfig({
      review: { rounds: 10, mode: 'gitlab' as never },
    }));
    expect(errors.map(e => e.path)).toContain('review.mode');
  });

  it('rejects invalid review.afterDone', () => {
    const errors = validateConfig(makeConfig({
      review: { rounds: 10, mode: 'server', afterDone: 'tag' as never },
    }));
    expect(errors.map(e => e.path)).toContain('review.afterDone');
  });

  it('accepts review.mode=server with afterDone=branch', () => {
    const errors = validateConfig(makeConfig({
      review: { rounds: 10, mode: 'server', afterDone: 'branch' },
    }));
    expect(errors.filter(e => e.path.startsWith('review.'))).toEqual([]);
  });

  describe('server.https', () => {
    it('accepts well-formed https config', () => {
      const cfg = makeConfig({
        server: { port: 443, https: { keyFile: '/etc/baxian/ssl/key.pem', certFile: '/etc/baxian/ssl/cert.pem' } },
      });
      expect(validateConfig(cfg)).toEqual([]);
    });

    it('rejects https with empty keyFile or certFile', () => {
      const cfg = makeConfig({
        server: { port: 443, https: { keyFile: '', certFile: '   ' } as never },
      });
      const paths = validateConfig(cfg).map(e => e.path);
      expect(paths).toContain('server.https.keyFile');
      expect(paths).toContain('server.https.certFile');
    });

    it('rejects relative cert paths (they resolve against process.cwd, which varies between systemd/manual launch)', () => {
      const cfg = makeConfig({
        server: { port: 443, https: { keyFile: 'ssl/key.pem', certFile: 'ssl/cert.pem' } },
      });
      const errors = validateConfig(cfg);
      const keyErr = errors.find(e => e.path === 'server.https.keyFile');
      const certErr = errors.find(e => e.path === 'server.https.certFile');
      expect(keyErr?.message).toMatch(/absolute path/);
      expect(certErr?.message).toMatch(/absolute path/);
    });
  });

  describe('server.allowedHosts', () => {
    it('accepts an array of non-empty strings', () => {
      const cfg = makeConfig({
        server: { port: 3000, allowedHosts: ['baxian.dev', 'www.baxian.dev'] },
      });
      expect(validateConfig(cfg)).toEqual([]);
    });

    it('rejects non-array allowedHosts', () => {
      const cfg = makeConfig({
        server: { port: 3000, allowedHosts: 'baxian.dev' as never },
      });
      const paths = validateConfig(cfg).map(e => e.path);
      expect(paths).toContain('server.allowedHosts');
    });

    it('rejects empty string entries inside allowedHosts', () => {
      const cfg = makeConfig({
        server: { port: 3000, allowedHosts: ['baxian.dev', ''] },
      });
      const paths = validateConfig(cfg).map(e => e.path);
      expect(paths).toContain('server.allowedHosts[1]');
    });
  });

  it('accepts valid server tmux probe settings', () => {
    const cfg = makeConfig({
      server: {
        port: 3000,
        tmuxProbePollIntervalMs: 10000,
        tmuxProbeTimeoutMs: 3000,
        tmuxProbeConcurrency: 4,
      },
    });
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('accepts server.tmuxProbePollIntervalMs at bounds [1000, 2^31-1]', () => {
    for (const ms of [1000, 10_000, 2_147_483_647]) {
      const cfg = makeConfig({
        server: {
          port: 3000,
          tmuxProbePollIntervalMs: ms,
          tmuxProbeTimeoutMs: 3000,
          tmuxProbeConcurrency: 4,
        },
      });
      expect(validateConfig(cfg).some(e => e.path === 'server.tmuxProbePollIntervalMs')).toBe(false);
    }
  });

  it('rejects invalid server tmux probe settings', () => {
    for (const ms of [999, 0, -1000, 1500.5, 2_147_483_648]) {
      const cfg = makeConfig({
        server: {
          port: 3000,
          tmuxProbePollIntervalMs: ms,
          tmuxProbeTimeoutMs: -1,
          tmuxProbeConcurrency: 1.5,
        },
      });
      const paths = validateConfig(cfg).map(e => e.path);
      expect(paths).toContain('server.tmuxProbePollIntervalMs');
      expect(paths).toContain('server.tmuxProbeTimeoutMs');
      expect(paths).toContain('server.tmuxProbeConcurrency');
    }
  });

  it('rejects non-positive server.bootstrapRetryIntervalMs', () => {
    const errors = validateConfig(makeConfig({
      server: { port: 3000, bootstrapRetryIntervalMs: 0 },
    }));
    expect(errors.some(e => e.path === 'server.bootstrapRetryIntervalMs')).toBe(true);
  });

  it('rejects non-integer server.bootstrapRetryIntervalMs', () => {
    const errors = validateConfig(makeConfig({
      server: { port: 3000, bootstrapRetryIntervalMs: 1.5 },
    }));
    expect(errors.some(e => e.path === 'server.bootstrapRetryIntervalMs')).toBe(true);
  });

  it('accepts undefined server.bootstrapRetryIntervalMs', () => {
    const errors = validateConfig(makeConfig({
      server: { port: 3000 },
    }));
    expect(errors.some(e => e.path === 'server.bootstrapRetryIntervalMs')).toBe(false);
  });

  it('accepts positive integer server.bootstrapRetryIntervalMs', () => {
    const errors = validateConfig(makeConfig({
      server: { port: 3000, bootstrapRetryIntervalMs: 60_000 },
    }));
    expect(errors.some(e => e.path === 'server.bootstrapRetryIntervalMs')).toBe(false);
  });

  it('accepts server.bootstrapRetryIntervalMs at bounds [1000, 2^31-1]', () => {
    for (const ms of [1000, 60_000, 2_147_483_647]) {
      const errors = validateConfig(makeConfig({
        server: { port: 3000, bootstrapRetryIntervalMs: ms },
      }));
      expect(errors.some(e => e.path === 'server.bootstrapRetryIntervalMs')).toBe(false);
    }
  });

  it('rejects server.bootstrapRetryIntervalMs below floor or above setInterval ceiling', () => {
    for (const ms of [999, 2_147_483_648]) {
      const errors = validateConfig(makeConfig({
        server: { port: 3000, bootstrapRetryIntervalMs: ms },
      }));
      expect(errors.some(e => e.path === 'server.bootstrapRetryIntervalMs')).toBe(true);
    }
  });

  it('accepts server.githubPollIntervalMs within [1000, 2^31-1]', () => {
    for (const ms of [1000, 60000, 2147483647]) {
      const cfg = makeConfig({ server: { port: 3000, githubPollIntervalMs: ms } });
      expect(validateConfig(cfg).some(e => e.path === 'server.githubPollIntervalMs')).toBe(false);
    }
  });

  it('rejects server.githubPollIntervalMs out of [1000, 2^31-1] or non-integer', () => {
    // sub-second floor, non-integer, zero, negative, 32-bit overflow
    for (const ms of [500, 0, -1000, 1500.5, 2147483648]) {
      const cfg = makeConfig({ server: { port: 3000, githubPollIntervalMs: ms } });
      const paths = validateConfig(cfg).map(e => e.path);
      expect(paths).toContain('server.githubPollIntervalMs');
    }
  });

  it('rejects invalid project.merge value', () => {
    const cfg = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: 'manual' as unknown as MergeStrategy,
        agent: [[makeAgent({ id: 'dd', role: 'dev' })]],
      }],
    });
    expect(validateConfig(cfg).some(e => e.path.endsWith('.merge'))).toBe(true);
  });

  it('rejects remote agent host with empty hostname', () => {
    const cfg = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({
          id: 'dd', role: 'dev', mode: 'remote',
          host: { hostname: '' },
        })]],
      }],
    });
    const paths = validateConfig(cfg).map(e => e.path);
    expect(paths.some(p => p.endsWith('host.hostname'))).toBe(true);
  });

  it('accepts remote agent with hostname only (user omitted)', () => {
    const cfg = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({
          id: 'dd', role: 'dev', mode: 'remote',
          host: { hostname: 'box' },
        })]],
      }],
    });
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('rejects host.user when set to an empty string', () => {
    const cfg = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({
          id: 'dd', role: 'dev', mode: 'remote',
          host: { hostname: 'box', user: '   ' },
        })]],
      }],
    });
    const paths = validateConfig(cfg).map(e => e.path);
    expect(paths.some(p => p.endsWith('host.user'))).toBe(true);
  });

  it('accepts agent without workdir (auto mode)', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'd1', role: 'dev', workdir: undefined })]],
      }],
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects agent with empty-string workdir', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'd1', role: 'dev', workdir: '' })]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.endsWith('.workdir'))).toBe(true);
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
      const config = makeConfig({
        project: [{ id: 'pp', repo, merge: null, agent: [[makeAgent({ id: 'd1', role: 'dev' })]] }],
      });
      const errors = validateConfig(config);
      expect(errors.some(e => e.path.endsWith('.repo'))).toBe(true);
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
      const config = makeConfig({
        project: [{ id: 'pp', repo, merge: null, agent: [[makeAgent({ id: 'd1', role: 'dev' })]] }],
      });
      const errors = validateConfig(config);
      expect(errors.some(e => e.path.endsWith('.repo'))).toBe(false);
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
      const config = makeConfig({
        project: [{ id: 'pp', repo, merge: null, agent: [[makeAgent({ id: 'd1', role: 'dev' })]] }],
      });
      const errors = validateConfig(config);
      expect(errors.some(e => e.path.endsWith('.repo'))).toBe(true);
    }
  });
});

describe('agent.yolo field', () => {
  it('accepts yolo: true', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'dd', role: 'dev', yolo: true })]],
      }],
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects yolo: false (interactive REPL only supports YOLO/bypass)', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'dd', role: 'dev', yolo: false })]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.includes('yolo') && /yolo=false is rejected/.test(e.message))).toBe(true);
  });

  it('rejects non-boolean yolo', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'dd', role: 'dev', yolo: 'true' as unknown as boolean })]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.includes('yolo'))).toBe(true);
  });
});

describe('agent.model field', () => {
  it('accepts non-empty model string', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'dd', role: 'dev', model: 'sonnet' })]],
      }],
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects empty-string model', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'dd', role: 'dev', model: '   ' })]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.endsWith('.model'))).toBe(true);
  });

  it('rejects non-string model', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'dd', role: 'dev', model: 42 as unknown as string })]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.endsWith('.model'))).toBe(true);
  });
});

describe('agent.addDirs field', () => {
  it('accepts empty addDirs array', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'dd', role: 'dev', addDirs: [] })]],
      }],
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('accepts addDirs of non-empty strings', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'dd', role: 'dev', addDirs: ['/a/b', '/c/d'] })]],
      }],
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects addDirs containing empty string', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'dd', role: 'dev', addDirs: ['/a/b', '   '] })]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => /\.addDirs\[1\]$/.test(e.path))).toBe(true);
  });

  it('rejects non-array addDirs', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'dd', role: 'dev', addDirs: '/a/b' as unknown as string[] })]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.endsWith('.addDirs'))).toBe(true);
  });
});

describe('project.agent empty array', () => {
  it('accepts empty agent array', () => {
    const config = makeConfig({
      project: [{ id: 'pp', repo: 'u/r', merge: null, agent: [] }],
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('still rejects non-array agent field', () => {
    const config = makeConfig({
      project: [{
        id: 'pp', repo: 'u/r', merge: null,
        agent: 'not-an-array' as unknown as AgentConfig[][],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.includes('agent'))).toBe(true);
  });
});

describe('id format validation', () => {
  it('rejects project.id with uppercase', () => {
    const config = makeConfig({
      project: [{ id: 'BadID', repo: 'a/b', merge: null, agent: [] }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.includes('id'))).toBe(true);
  });

  it('rejects project.id with special chars', () => {
    const config = makeConfig({
      project: [{ id: '../etc/passwd', repo: 'a/b', merge: null, agent: [] }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.includes('id'))).toBe(true);
  });

  it('rejects project.id with leading dash', () => {
    const config = makeConfig({
      project: [{ id: '-leading', repo: 'a/b', merge: null, agent: [] }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.includes('id'))).toBe(true);
  });

  it('accepts well-formed ids', () => {
    const config = makeConfig({
      project: [{ id: 'kk-cc', repo: 'a/b', merge: null, agent: [] }],
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects agent.id with bad format', () => {
    const config = makeConfig({
      project: [{
        id: 'p1', repo: 'a/b', merge: null,
        agent: [[makeAgent({ id: 'BAD', role: 'dev' })]],
      }],
    });
    const errors = validateConfig(config);
    expect(errors.some(e => e.path.includes('agent') && e.path.includes('id'))).toBe(true);
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
  it('accepts a well-formed registry', () => {
    const config = makeConfig({ host: [{ id: 'box', hostname: 'h.example.com', port: 22, user: 'u' }] });
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects a host missing an id', () => {
    const config = makeConfig({ host: [{ hostname: 'h' } as never] });
    expect(validateConfig(config).some(e => e.path === 'host[0].id')).toBe(true);
  });

  it('rejects duplicate host ids', () => {
    const config = makeConfig({ host: [{ id: 'box', hostname: 'h1' }, { id: 'box', hostname: 'h2' }] });
    expect(validateConfig(config).some(e => /Duplicate host id/.test(e.message))).toBe(true);
  });

  it('rejects a host missing a hostname', () => {
    const config = makeConfig({ host: [{ id: 'box', hostname: '' }] });
    expect(validateConfig(config).some(e => e.path === 'host[0].hostname')).toBe(true);
  });

  it('rejects a port out of range', () => {
    const config = makeConfig({ host: [{ id: 'box', hostname: 'h', port: 70000 }] });
    expect(validateConfig(config).some(e => e.path === 'host[0].port')).toBe(true);
  });
});

describe('remote agent host references', () => {
  it('accepts a remote agent referencing an existing host id', () => {
    const config = makeConfig({
      host: [{ id: 'box', hostname: 'h', user: 'u' }],
      project: [{
        id: 'proj', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'rdev', role: 'dev', mode: 'remote', host: 'box', workdir: undefined })]],
      }],
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects a remote agent referencing an unknown host id', () => {
    const config = makeConfig({
      host: [],
      project: [{
        id: 'proj', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'rdev', role: 'dev', mode: 'remote', host: 'ghost', workdir: undefined })]],
      }],
    });
    expect(validateConfig(config).some(e => /unknown host id/.test(e.message))).toBe(true);
  });

  it('still accepts a legacy inline host object', () => {
    const config = makeConfig({
      project: [{
        id: 'proj', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'rdev', role: 'dev', mode: 'remote', host: { hostname: 'legacy', user: 'old' }, workdir: undefined })]],
      }],
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects an inline host carrying a password (secrets belong in the registry)', () => {
    const config = makeConfig({
      project: [{
        id: 'proj', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'rdev', role: 'dev', mode: 'remote', host: { hostname: 'legacy', password: 'x' } as never, workdir: undefined })]],
      }],
    });
    expect(validateConfig(config).some(e => /must not carry a password/.test(e.message))).toBe(true);
  });

  it('rejects a legacy inline host with an out-of-range port (interpolated into ssh)', () => {
    const config = makeConfig({
      project: [{
        id: 'proj', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'rdev', role: 'dev', mode: 'remote', host: { hostname: 'legacy', port: 70000 } as never, workdir: undefined })]],
      }],
    });
    expect(validateConfig(config).some(e => e.path === 'project.proj.agent.rdev.host.port')).toBe(true);
  });

  it('treats a null agent.host as missing (clean error, not a TypeError/500)', () => {
    const config = makeConfig({
      project: [{
        id: 'proj', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'rdev', role: 'dev', mode: 'remote', host: null as never, workdir: undefined })]],
      }],
    });
    expect(() => validateConfig(config)).not.toThrow();
    expect(validateConfig(config).some(e => /must reference a host/.test(e.message))).toBe(true);
  });

  it('rejects a non-string, non-object agent.host (e.g. number) cleanly', () => {
    const config = makeConfig({
      project: [{
        id: 'proj', repo: 'u/r', merge: null,
        agent: [[makeAgent({ id: 'rdev', role: 'dev', mode: 'remote', host: 42 as never, workdir: undefined })]],
      }],
    });
    expect(() => validateConfig(config)).not.toThrow();
    expect(validateConfig(config).some(e => e.path === 'project.proj.agent.rdev.host')).toBe(true);
  });
});
