import { describe, it, expect } from 'vitest';
import { normalizeRepoUrl, repoSlug, parseGitRemote, isGitHubRepo, isSafeGitHost, redactGitCredentials, hasEmbeddedCredentials } from '../../src/shared/index.js';

describe('normalizeRepoUrl', () => {
  it('extracts owner/repo from every supported GitHub URL form', () => {
    const cases: Array<[string, string, string]> = [
      ['HTTPS with .git', 'https://github.com/user/repo.git', 'user/repo'],
      ['HTTPS without .git', 'https://github.com/user/repo', 'user/repo'],
      ['SSH with .git', 'git@github.com:user/repo.git', 'user/repo'],
      ['SSH without .git', 'git@github.com:user/repo', 'user/repo'],
      ['ssh:// with .git', 'ssh://git@github.com/user/repo.git', 'user/repo'],
      ['ssh:// without .git', 'ssh://git@github.com/user/repo', 'user/repo'],
      ['trailing slash', 'https://github.com/user/repo/', 'user/repo'],
    ];
    for (const [label, input, expected] of cases) {
      expect.soft(normalizeRepoUrl(input), label).toBe(expected);
    }
  });

  it('returns null for non-GitHub or malformed input', () => {
    expect.soft(normalizeRepoUrl('https://gitlab.com/user/repo'), 'non-GitHub host').toBeNull();
    expect.soft(normalizeRepoUrl(''), 'empty string').toBeNull();
    expect.soft(normalizeRepoUrl('not-a-url'), 'unparseable').toBeNull();
    expect.soft(normalizeRepoUrl('https://github.com/group/sub/repo.git'), 'multi-segment path').toBeNull();
  });
});

describe('repoSlug', () => {
  it('extracts the slug from URL spellings and passes legacy slugs through', () => {
    const cases: Array<[string, string, string]> = [
      ['HTTPS URL', 'https://github.com/example-owner/example-repo.git', 'example-owner/example-repo'],
      ['SSH URL', 'git@github.com:example-owner/example-repo.git', 'example-owner/example-repo'],
      ['ssh:// URL', 'ssh://git@github.com/example-owner/example-repo', 'example-owner/example-repo'],
      ['legacy slug', 'example-owner/example-repo', 'example-owner/example-repo'],
      ['padded legacy slug', '  example-owner/example-repo ', 'example-owner/example-repo'],
    ];
    for (const [label, input, expected] of cases) {
      expect.soft(repoSlug(input), label).toBe(expected);
    }
  });

  it('is idempotent and case-preserving', () => {
    expect(repoSlug(repoSlug('https://github.com/Owner/Repo.git'))).toBe('Owner/Repo');
  });

  it('URL and legacy spellings of the same repo normalize to the same slug', () => {
    const spellings = [
      'example-owner/example-repo',
      'https://github.com/example-owner/example-repo.git',
      'https://github.com/example-owner/example-repo',
      'git@github.com:example-owner/example-repo.git',
    ];
    expect(new Set(spellings.map(repoSlug)).size).toBe(1);
  });
});

describe('parseGitRemote', () => {
  it('parses any-host https / ssh-url / scp into host + path', () => {
    const cases: Array<[string, string, { host: string; path: string } | null]> = [
      ['github https', 'https://github.com/example-owner/example-repo.git', { host: 'github.com', path: 'example-owner/example-repo' }],
      ['gitlab https', 'https://gitlab.example.com/group/proj.git', { host: 'gitlab.example.com', path: 'group/proj' }],
      ['gitlab subgroup', 'https://gitlab.example.com/group/sub/proj', { host: 'gitlab.example.com', path: 'group/sub/proj' }],
      ['https with port', 'https://gitlab.example.com:8443/group/proj.git', { host: 'gitlab.example.com:8443', path: 'group/proj' }],
      ['scp', 'git@gitlab.com:group/proj.git', { host: 'gitlab.com', path: 'group/proj' }],
      ['ssh url with port', 'ssh://git@gitlab.example.com:2222/group/sub/proj.git', { host: 'gitlab.example.com:2222', path: 'group/sub/proj' }],
      ['https userinfo stripped', 'https://oauth2:TOKEN@gitlab.example.com/group/proj.git', { host: 'gitlab.example.com', path: 'group/proj' }],
      ['ssh-url userinfo stripped', 'ssh://git@gitlab.example.com/group/proj', { host: 'gitlab.example.com', path: 'group/proj' }],
      ['host lowercased', 'https://GitLab.Example.COM/Group/Proj.git', { host: 'gitlab.example.com', path: 'Group/Proj' }],
      ['trailing slash', 'https://gitlab.example.com/group/proj/', { host: 'gitlab.example.com', path: 'group/proj' }],
      ['bare slug (no host)', 'owner/repo', null],
      ['unparseable', 'not-a-url', null],
      ['empty', '', null],
    ];
    for (const [label, input, expected] of cases) {
      expect.soft(parseGitRemote(input), label).toEqual(expected);
    }
  });

  it('preserves path case (generic remotes can be case-sensitive)', () => {
    expect(parseGitRemote('https://gitlab.example.com/Group/Repo.git')?.path).toBe('Group/Repo');
  });
});

describe('isGitHubRepo', () => {
  it('is true for github.com URLs (any form, incl. explicit port) and legacy bare owner/repo', () => {
    for (const repo of [
      'https://github.com/o/r.git',
      'git@github.com:o/r.git',
      'ssh://git@github.com/o/r',
      'owner/repo',
      'https://GITHUB.com/o/r',
      'https://github.com:443/o/r.git',
      'ssh://git@github.com:22/o/r',
    ]) expect.soft(isGitHubRepo(repo), repo).toBe(true);
  });

  it('is false for non-github hosts and unparseable input', () => {
    for (const repo of [
      'https://gitlab.example.com/group/proj.git',
      'git@gitlab.com:group/proj.git',
      'https://gitlab.example.com:8443/g/p',
      'https://gitea.internal/team/repo',
      'not-a-url',
      '',
    ]) expect.soft(isGitHubRepo(repo), repo).toBe(false);
  });
});

describe('isSafeGitHost', () => {
  it('accepts DNS-style hosts (single label, dotted, with port, IP)', () => {
    for (const h of ['gitlab.example.com', 'gitlab.example.com:8443', 'localhost', 'gitea-internal', '192.168.1.5'])
      expect.soft(isSafeGitHost(h), h).toBe(true);
  });

  it('rejects traversal, empty labels, and shell metacharacters', () => {
    for (const h of [
      '', '..', '.', 'a..b', '.gitlab.com', 'gitlab.com:',
      'gitlab.example.com;touch x', 'gitlab.example.com$(touch x)', 'gitlab.example.com`id`',
      'gitlab.example.com|x', 'host with space', 'gitlab.com/../etc',
    ]) expect.soft(isSafeGitHost(h), h).toBe(false);
  });
});

describe('redactGitCredentials', () => {
  it('strips embedded userinfo from https/ssh URLs anywhere in the text', () => {
    expect(redactGitCredentials("git clone 'https://oauth2:TOK@gitlab.example.com/g/p.git' failed"))
      .toBe("git clone 'https://gitlab.example.com/g/p.git' failed");
    expect(redactGitCredentials("fatal: Authentication failed for 'https://user:pw@host/x.git'"))
      .toBe("fatal: Authentication failed for 'https://host/x.git'");
    expect(redactGitCredentials('ssh://git:secret@host/x')).toBe('ssh://host/x');
  });

  it('leaves credential-free text unchanged', () => {
    expect(redactGitCredentials('https://gitlab.example.com/g/p.git')).toBe('https://gitlab.example.com/g/p.git');
    expect(redactGitCredentials('owner/repo')).toBe('owner/repo');
  });
});

describe('hasEmbeddedCredentials', () => {
  it('flags http(s) userinfo and ssh URL userinfo containing a secret', () => {
    for (const r of [
      'https://oauth2:TOKEN@gitlab.example.com/g/p.git',
      'https://TOKEN@host/g/p',
      'http://u:p@host/x',
      'ssh://git:TOKEN@gitlab.example.com/g/p',
    ]) expect.soft(hasEmbeddedCredentials(r), r).toBe(true);
  });

  it('does not flag plain ssh logins, credential-free https, or legacy slugs', () => {
    for (const r of [
      'ssh://git@gitlab.example.com/g/p',
      'git@gitlab.example.com:g/p.git',
      'https://gitlab.example.com/g/p.git',
      'owner/repo',
    ]) expect.soft(hasEmbeddedCredentials(r), r).toBe(false);
  });
});
