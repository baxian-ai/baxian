import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/config/validator.js';
import type { BaxianConfig, ProjectConfig } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';

function baseProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'p1',
    repo: 'https://gitlab.example.com/g/sub/proj.git',
    merge: null,
    review: { mode: 'git' },
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

describe("validateConfig: review.mode 'git'", () => {
  it("passes the enum check but hits the temporary operational gate", () => {
    const msgs = messages(baseConfig());
    expect(msgs).toMatch(/not yet operational/);
    expect(msgs).not.toMatch(/must be 'github' or 'server'/);
  });

  it("github repos may use mode 'git'; only the temporary gate fires", () => {
    const msgs = messages(baseConfig({ repo: 'https://github.com/a/b.git', gitCli: undefined }));
    expect(msgs).toMatch(/not yet operational/);
    expect(msgs).not.toMatch(/must use review\.mode/);
    expect(msgs).not.toMatch(/gitCli/);
  });

  it("github ssh/scp/bare-slug repos pass the URL-form check in mode 'git'", () => {
    for (const repo of ['git@github.com:a/b.git', 'ssh://git@github.com/a/b.git', 'a/b']) {
      const msgs = messages(baseConfig({ repo, gitCli: undefined }));
      expect(msgs, repo).toMatch(/not yet operational/);
      expect(msgs, repo).not.toMatch(/http\(s\)/);
    }
  });

  it('non-github repos in git mode require gitCli, with the install-or-server hint', () => {
    const msgs = messages(baseConfig({ gitCli: undefined }));
    expect(msgs).toMatch(/gitCli\.tool/);
    expect(msgs).toMatch(/plugins/);
    expect(msgs).toMatch(/review\.mode 'server'/);
  });

  it('requires gitCli for git mode; rejects ssh/scp/userinfo repo URLs', () => {
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

  it('rejects a duplicate normalized repo URL across git-mode projects', () => {
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

  it('rejects control characters in project.repo on any project, git mode or not', () => {
    for (const repo of ['https://gl.example.com/g/p\u0000.git', 'a/b\rc', 'https://gl.example.com/g/\np.git']) {
      const msgs = messages(baseConfig({ repo, review: { mode: 'server' }, gitCli: undefined }));
      expect(msgs, JSON.stringify(repo)).toMatch(/control characters/);
    }
  });

  it('rejects a repo URL that is not parseable (e.g. a non-numeric port)', () => {
    const msgs = messages(baseConfig({ repo: 'https://gl.example.com:notaport/g/p.git' }));
    expect(msgs).toMatch(/not.*parseable|parseable.*URL/i);
  });

  it('gitCli on a github project is legal (redundant but harmless); existing modes stay untouched', () => {
    expect(messages(baseConfig({
      repo: 'https://github.com/a/b.git',
      review: { mode: 'github' },
      gitCli: { tool: 'gh' },
    }))).toBe('');

    expect(validateConfig(baseConfig({ review: { mode: 'server' }, gitCli: undefined }))).toEqual([]);
  });
});

function malformed(overrides: Record<string, unknown>): BaxianConfig {
  return baseConfig(overrides as unknown as Partial<ProjectConfig>);
}

describe('validateGitMode: malformed input does not crash', () => {
  it('gitCli: null is reported as an object-shape error, not a crash', () => {
    const config = malformed({ gitCli: null });
    expect(() => validateConfig(config)).not.toThrow();
    expect(messages(config)).toMatch(/gitCli must be an object/);
  });

  it("repo missing on a 'git' mode project does not crash and is not double-reported", () => {
    const config = malformed({ repo: undefined, gitCli: undefined });
    expect(() => validateConfig(config)).not.toThrow();
    const msgs = messages(config);
    expect(msgs).toMatch(/project\.repo must be a non-empty string/);
    expect(msgs).not.toMatch(/http\(s\)|not yet operational/);
  });

  it("repo non-string on a 'git' mode project does not crash", () => {
    const config = malformed({ repo: 12345, gitCli: undefined });
    expect(() => validateConfig(config)).not.toThrow();
    expect(messages(config)).toMatch(/project\.repo must be a non-empty string/);
  });

  it('gitCli present with repo missing does not crash even outside git mode', () => {
    const config = malformed({ repo: undefined, review: { mode: 'server' }, gitCli: { tool: 'glab' } });
    expect(() => validateConfig(config)).not.toThrow();
    expect(messages(config)).toMatch(/project\.repo must be a non-empty string/);
  });
});
