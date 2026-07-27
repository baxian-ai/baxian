import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/config/validator.js';
import type { BaxianConfig, ProjectConfig } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';

function baseProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'p1',
    repo: 'https://gitlab.example.com/g/sub/proj.git',
    merge: null,
    gitCli: { tool: 'glab' },
    agent: [],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<ProjectConfig> = {}): BaxianConfig {
  return {
    review: { rounds: 3 },
    server: DEFAULT_SERVER_CONFIG,
    host: [],
    project: [baseProject(overrides)],
  };
}

function messages(config: BaxianConfig): string {
  return validateConfig(config).map(e => e.message).join('\n');
}

describe('validateConfig: PR platform workflow', () => {
  it('accepts a well-formed project', () => {
    expect(messages(baseConfig())).toBe('');
  });

  it('requires an explicit driver tool for non-GitHub projects', () => {
    const cfg: BaxianConfig = {
      review: { rounds: 3 },
      server: DEFAULT_SERVER_CONFIG,
      host: [],
      project: [{ id: 'p1', repo: 'https://gitlab.example.com/g/p.git', merge: null, agent: [] }],
    };
    expect(messages(cfg)).toMatch(/require gitCli\.tool/);
  });

  it('GitHub repos use gh with zero config', () => {
    const msgs = messages(baseConfig({ repo: 'https://github.com/a/b.git', gitCli: undefined }));
    expect(msgs).toBe('');
    expect(msgs).not.toMatch(/gitCli/);
  });

  it('accepts GitHub ssh, scp, and bare-slug forms', () => {
    for (const repo of ['git@github.com:a/b.git', 'ssh://git@github.com/a/b.git', 'a/b']) {
      const msgs = messages(baseConfig({ repo, gitCli: undefined }));
      expect(msgs, repo).toBe('');
    }
  });

  it("rejects a bare slug when the resolved tool is not 'gh' (plain git cannot clone it)", () => {
    const bad = messages(baseConfig({ repo: 'owner/repo', gitCli: { tool: 'forge' } }));
    expect(bad).toMatch(/bare owner\/repo slug requires the resolved tool 'gh'/);

    const bareDefault = messages(baseConfig({ repo: 'owner/repo', gitCli: undefined }));
    expect(bareDefault).not.toMatch(/bare owner\/repo slug/);

    const explicitGh = messages(baseConfig({ repo: 'owner/repo', gitCli: { tool: 'gh' } }));
    expect(explicitGh).not.toMatch(/bare owner\/repo slug/);

    const fullUrl = messages(baseConfig({ repo: 'https://github.com/owner/repo.git', gitCli: { tool: 'forge' } }));
    expect(fullUrl).not.toMatch(/bare owner\/repo slug/);
  });

  it('non-GitHub repos require a matching git-driver plugin declaration', () => {
    const msgs = messages(baseConfig({ gitCli: undefined }));
    expect(msgs).toMatch(/gitCli\.tool/);
    expect(msgs).toMatch(/plugins/);
  });

  it('requires gitCli and rejects unsupported or credential-bearing repo URLs', () => {
    expect(messages(baseConfig({ gitCli: undefined }))).toMatch(/gitCli/);

    for (const repo of [
      'ssh://git@gl.example.com:2222/g/p.git',
      'git@gl.example.com:g/p.git',
      'https://user:pw@gl.example.com/g/p.git',
    ]) {
      expect(messages(baseConfig({ repo })), repo).toMatch(/http\(s\)|credentials/i);
    }
  });

  it('enforces gitCli.tool shape and an absolute gitCli.binary', () => {
    expect(messages(baseConfig({ gitCli: { tool: 'Bad Tool' } }))).toMatch(/tool/);
    expect(messages(baseConfig({ gitCli: { tool: 'glab', binary: 'relative/glab' } }))).toMatch(/absolute/);
  });

  it('rejects a duplicate normalized repo URL', () => {
    const config = baseConfig();
    config.project.push({ ...config.project[0], id: 'p2' });
    expect(messages(config)).toMatch(/unique|duplicate/i);
  });

  it('normalizes trailing slash before stripping .git, so "p.git/" dedupes against "p"', () => {
    const config = baseConfig({ repo: 'https://gl.example.com/g/p.git/' });
    config.project.push(baseProject({ id: 'p2', repo: 'https://gl.example.com/g/p' }));
    expect(messages(config)).toMatch(/unique|duplicate/i);
  });

  it('default-port alias dedupes against the portless URL', () => {
    const config = baseConfig();
    config.project.push(baseProject({ id: 'p2', repo: 'https://gitlab.example.com:443/g/sub/proj' }));
    expect(messages(config)).toMatch(/unique|duplicate/i);
  });

  it('an explicit non-default port stays a distinct repo', () => {
    const config = baseConfig();
    config.project.push(baseProject({ id: 'p2', repo: 'https://gitlab.example.com:8443/g/sub/proj.git' }));
    expect(messages(config)).not.toMatch(/unique|duplicate/i);
  });

  it('github mixed spellings (slug / https / ssh / case / .GIT) normalize to one key and get rejected', () => {
    const config = baseConfig({ repo: 'https://github.com/Owner/Repo.git', gitCli: undefined });
    config.project.push(baseProject({ id: 'p2', repo: 'git@github.com:owner/repo.git', gitCli: undefined }));
    config.project.push(baseProject({ id: 'p3', repo: 'owner/repo', gitCli: undefined }));
    config.project.push(baseProject({ id: 'p4', repo: 'https://github.com/OWNER/Repo.GIT', gitCli: undefined }));
    const msgs = messages(config);
    expect(msgs.match(/unique|duplicate/gi)!.length).toBeGreaterThanOrEqual(3);
  });

  it('non-github repos differing only in path case stay distinct (case-sensitive forge paths)', () => {
    const config = baseConfig({ repo: 'https://gl.example.com/Team/App.git' });
    config.project.push(baseProject({ id: 'p2', repo: 'https://gl.example.com/team/app.git' }));
    expect(messages(config)).not.toMatch(/unique|duplicate/i);
  });

  it('rejects a non-string gitCli.notes; a string passes', () => {
    expect(messages(malformed({ gitCli: { tool: 'glab', notes: 123 } }))).toMatch(/gitCli\.notes must be a string/);
    expect(messages(baseConfig({ gitCli: { tool: 'glab', notes: '实例在 8443 端口；评论用中文' } })))
      .not.toMatch(/notes/);
  });

  it('rejects control characters in gitCli.notes (cli-notes is a line-based descriptor)', () => {
    for (const notes of ['foo\ncli-repo: attacker/repo', 'tab\there', 'cr\rhere']) {
      expect(messages(baseConfig({ gitCli: { tool: 'glab', notes } })), JSON.stringify(notes))
        .toMatch(/control characters/);
    }
  });

  it("rejects control characters in gitCli.binary (isAbsolute alone passes '\\n' forgeries)", () => {
    expect(messages(baseConfig({ gitCli: { tool: 'forge', binary: '/opt/bin/gh\nbase: forged' } })))
      .toMatch(/control characters/);
  });

  it('rejects control characters in project.repo', () => {
    for (const repo of ['https://gl.example.com/g/p\u0000.git', 'a/b\rc', 'https://gl.example.com/g/\np.git']) {
      const msgs = messages(baseConfig({ repo, gitCli: undefined }));
      expect(msgs, JSON.stringify(repo)).toMatch(/control characters/);
    }
  });

  it('rejects a repo URL that is not parseable (e.g. a non-numeric port)', () => {
    const msgs = messages(baseConfig({ repo: 'https://gl.example.com:notaport/g/p.git' }));
    expect(msgs).toMatch(/not.*parseable|parseable.*URL/i);
  });

  it('GitHub uses its built-in gh binding and accepts an explicit gh declaration', () => {
    expect(messages(baseConfig({
      repo: 'https://github.com/a/b.git',
      gitCli: undefined,
    }))).toBe('');
    expect(messages(baseConfig({
      repo: 'https://github.com/a/b.git',
      gitCli: { tool: 'gh' },
    }))).toBe('');
  });
});

function malformed(overrides: Record<string, unknown>): BaxianConfig {
  return baseConfig(overrides as unknown as Partial<ProjectConfig>);
}

describe('platform config: malformed input does not crash', () => {
  it('gitCli: null is reported as an object-shape error, not a crash', () => {
    const config = malformed({ gitCli: null });
    expect(() => validateConfig(config)).not.toThrow();
    expect(messages(config)).toMatch(/gitCli must be an object/);
  });

  it('a missing repo does not crash and is not double-reported', () => {
    const config = malformed({ repo: undefined, gitCli: undefined });
    expect(() => validateConfig(config)).not.toThrow();
    const msgs = messages(config);
    expect(msgs).toMatch(/project\.repo must be a non-empty string/);
    expect(msgs).not.toMatch(/http\(s\)/);
  });

  it('a non-string repo does not crash', () => {
    const config = malformed({ repo: 12345, gitCli: undefined });
    expect(() => validateConfig(config)).not.toThrow();
    expect(messages(config)).toMatch(/project\.repo must be a non-empty string/);
  });

  it('gitCli present with repo missing does not crash', () => {
    const config = malformed({ repo: undefined, gitCli: { tool: 'glab' } });
    expect(() => validateConfig(config)).not.toThrow();
    expect(messages(config)).toMatch(/project\.repo must be a non-empty string/);
  });
});

describe('platform repo uniqueness (entry-set scope)', () => {
  const cfg = (projects: ProjectConfig[]): BaxianConfig =>
    ({ review: { rounds: 3 }, server: DEFAULT_SERVER_CONFIG, host: [], project: projects });
  const gh = (id: string, over: Partial<ProjectConfig> = {}): ProjectConfig =>
    ({ id, repo: 'https://github.com/owner/repo.git', merge: null, agent: [], ...over });

  it('rejects two projects sharing one normalized repo', () => {
    const errors = validateConfig(cfg([gh('proj-a'), gh('proj-b')]));
    expect(errors.map(e => e.message).join('\n')).toMatch(/must be unique across platform-polled projects/);
  });

  it('reports the collision on the second project, naming the first', () => {
    const errors = validateConfig(cfg([gh('first'), gh('second')]));
    expect(errors).toEqual([expect.objectContaining({
      path: 'project[1].repo',
      message: expect.stringContaining("already used by project 'first'"),
    })]);
  });
});
