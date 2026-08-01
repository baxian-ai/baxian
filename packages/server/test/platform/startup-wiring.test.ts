import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('GitHub recovery wiring', () => {
  it('runs recovery before event registration and includes both durable sweeps in maintenance', async () => {
    const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(source.indexOf('await agentManager.recover()'))
      .toBeLessThan(source.indexOf('registerEventHandlers(eventBus, agentManager)'));
    expect(source).toMatch(
      /name: 'GitMaintenance'[\s\S]*retryPendingGitReviewDispatches\(\)[\s\S]*retryGitRemoteCleanupIntents\(\)/,
    );
  });

  it('starts durable sweeps directly without migration branches', async () => {
    const source = await readFile(new URL('../../src/agent/manager.ts', import.meta.url), 'utf8');
    const recover = source.slice(source.indexOf('async recover(): Promise<void>'));
    expect(recover).not.toContain('migrateLegacyGit');
    expect(recover).toContain('retryGitRemoteCleanupIntents()');
    expect(recover).toContain('recoverClaimedGitReviewDispatches()');
  });
});
