import { describe, expect, it } from 'vitest';
import { hasEmbeddedCredentials, redactGitCredentials } from '../../src/shared/index.js';

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
