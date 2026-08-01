import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/validator.js';
import type { BaxianConfig, ProjectConfig } from '../../src/shared/index.js';

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj',
    repo: 'https://github.com/owner/repo.git',
    merge: null,
    agent: [],
    ...overrides,
  };
}

function config(overrides: Partial<ProjectConfig> = {}): BaxianConfig {
  return {
    review: { rounds: 3 },
    server: {
      port: 3000,
      host: '127.0.0.1',
      platformPollIntervalMs: 30_000,
      tmuxProbePollIntervalMs: 10_000,
      tmuxProbeTimeoutMs: 5_000,
      tmuxProbeConcurrency: 4,
      bootstrapRetryIntervalMs: 10_000,
      dispatchReconcileIntervalMs: 10_000,
      dispatchBusyWaitBudgetMs: 30_000,
      dispatchReconcileMaxAttempts: 3,
    },
    host: [],
    project: [project(overrides)],
  };
}

const messages = (value: BaxianConfig): string => validateConfig(value).map(error => error.message).join('\n');

describe('GitHub repository configuration', () => {
  it.each([
    'https://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
  ])('accepts a full GitHub remote: %s', repo => {
    expect(validateConfig(config({ repo }))).toEqual([]);
  });

  it.each([
    'owner/repo',
    'http://github.com/owner/repo.git',
    'https://gitlab.com/owner/repo.git',
    'https://github.example.com/owner/repo.git',
    'https://github.com/owner',
  ])('rejects unsupported or abbreviated repository identities: %s', repo => {
    const errors = validateConfig(config({ repo }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/full github\.com/);
  });

  it('rejects embedded credentials', () => {
    expect(messages(config({ repo: 'https://user:secret@github.com/owner/repo.git' })))
      .toMatch(/must not embed credentials/);
  });

  it('treats HTTPS, SSH, case, and .git variants as one repository identity', () => {
    const value = config();
    value.project.push(project({ id: 'proj-two', repo: 'git@github.com:OWNER/REPO.git' }));
    expect(messages(value)).toMatch(/must be unique/);
  });
});
