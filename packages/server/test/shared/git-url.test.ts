import { describe, expect, it } from 'vitest';
import {
  hasEmbeddedCredentials,
  isGitHubRepo,
  normalizeRepoUrl,
  redactGitCredentials,
  repoIdentityKey,
  repoSlug,
} from '../../src/shared/index.js';

const URLS = [
  'https://github.com/Owner/Repo.git',
  'git@github.com:Owner/Repo.git',
  'ssh://git@github.com/Owner/Repo.git',
];

describe('GitHub repository URLs', () => {
  it('accepts the supported full URL forms and extracts the slug', () => {
    for (const url of URLS) {
      expect.soft(isGitHubRepo(url), url).toBe(true);
      expect.soft(normalizeRepoUrl(url), url).toBe('Owner/Repo');
      expect.soft(repoSlug(url), url).toBe('Owner/Repo');
    }
  });

  it('rejects shorthands, other hosts, insecure HTTP, ports, and malformed paths', () => {
    for (const url of [
      'owner/repo',
      'https://gitlab.com/owner/repo.git',
      'http://github.com/owner/repo.git',
      'https://github.com:443/owner/repo.git',
      'ssh://git@github.com:22/owner/repo.git',
      'https://github.com/group/sub/repo.git',
      'not-a-url',
      '',
    ]) {
      expect.soft(isGitHubRepo(url), url).toBe(false);
      expect.soft(normalizeRepoUrl(url), url).toBeNull();
    }
  });

  it('uses one case-insensitive identity for every supported spelling', () => {
    for (const url of URLS) {
      expect(repoIdentityKey(url)).toBe('github.com/owner/repo');
    }
    expect(repoIdentityKey('owner/repo')).toBe('owner/repo');
  });
});

describe('credential safety', () => {
  it('detects embedded HTTP and SSH URL secrets', () => {
    for (const url of [
      'https://oauth2:TOKEN@github.com/o/r.git',
      'https://TOKEN@github.com/o/r.git',
      'ssh://git:TOKEN@github.com/o/r.git',
    ]) expect.soft(hasEmbeddedCredentials(url), url).toBe(true);
    expect(hasEmbeddedCredentials('ssh://git@github.com/o/r.git')).toBe(false);
  });

  it('redacts embedded userinfo from diagnostic text', () => {
    expect(redactGitCredentials("git clone 'https://oauth2:TOK@github.com/o/r.git' failed"))
      .toBe("git clone 'https://github.com/o/r.git' failed");
    expect(redactGitCredentials('ssh://git:secret@github.com/o/r.git'))
      .toBe('ssh://github.com/o/r.git');
  });
});
