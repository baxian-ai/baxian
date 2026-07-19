import { describe, it, expect } from 'vitest';
import { gitBindingBlockers } from '../../src/api/platform-guard.js';
import type { AgentManager } from '../../src/agent/manager.js';
import type { BaxianConfig, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';

function config(over: Partial<BaxianConfig['project'][number]> = {}, review: BaxianConfig['review'] = { rounds: 2 }): BaxianConfig {
  return {
    review,
    server: DEFAULT_SERVER_CONFIG,
    project: [{
      id: 'proj', repo: 'git@github.com:owner/repo.git', merge: null, agent: [],
      review: { mode: 'git' }, ...over,
    }],
  } as BaxianConfig;
}

function managerWith(taskIds: string[]): AgentManager {
  return {
    listActiveGitTasks: async () => taskIds.map(id => ({ id } as TaskState)),
  } as unknown as AgentManager;
}

describe('gitBindingBlockers', () => {
  it('blocks repo, tool, and effective-mode changes while git tasks are active', async () => {
    const manager = managerWith(['task-1']);
    const current = config();
    for (const next of [
      config({ repo: 'git@github.com:owner/other.git' }),
      config({ gitCli: { tool: 'forge' } }),
      config({ review: { mode: 'server' } }),
    ]) {
      expect(await gitBindingBlockers(manager, current, next)).toEqual([
        { projectId: 'proj', taskIds: ['task-1'] },
      ]);
    }
  });

  it('blocks a global review-mode flip that changes the project effective mode', async () => {
    const manager = managerWith(['task-2']);
    const current = config({ review: undefined }, { rounds: 2, mode: 'git' });
    const next = config({ review: undefined }, { rounds: 2, mode: 'server' });
    expect(await gitBindingBlockers(manager, current, next)).toHaveLength(1);
  });

  it('blocks removing a project that still has active git tasks', async () => {
    const manager = managerWith(['task-3']);
    const current = config();
    const next: BaxianConfig = { ...current, project: [] };
    expect(await gitBindingBlockers(manager, current, next)).toHaveLength(1);
  });

  it('passes identity-preserving edits and idle projects', async () => {
    const current = config();
    expect(await gitBindingBlockers(managerWith(['task-4']), current, config({ merge: 'auto' }))).toEqual([]);
    expect(await gitBindingBlockers(managerWith([]), current, config({ repo: 'git@github.com:owner/other.git' })))
      .toEqual([]);
  });

  it('protects identity changes even after the live mode drifted away from git', async () => {
    const manager = managerWith(['task-5']);
    const current = config({ review: { mode: 'server' } });
    const next = config({ review: { mode: 'server' }, repo: 'git@github.com:owner/other.git' });
    expect(await gitBindingBlockers(manager, current, next)).toEqual([
      { projectId: 'proj', taskIds: ['task-5'] },
    ]);
    expect(await gitBindingBlockers(managerWith([]), current, next)).toEqual([]);
  });
});
