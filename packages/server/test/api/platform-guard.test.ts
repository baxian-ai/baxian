import { describe, it, expect } from 'vitest';
import { activeParticipantBlockers, gitBindingBlockerDetails, gitBindingBlockers } from '../../src/api/platform-guard.js';
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

function managerWithBound(tasks: Array<{
  id: string;
  projectId: string;
  repoKey: string;
  mode?: string;
  tool?: string;
}>): AgentManager {
  return {
    listActiveGitTasks: async (projectId?: string) =>
      tasks
        .filter(t => projectId === undefined || t.projectId === projectId)
        .map(t => ({
          id: t.id,
          projectId: t.projectId,
          platformBinding: { mode: t.mode ?? 'git', repoKey: t.repoKey, tool: t.tool ?? 'gh' },
        } as TaskState)),
  } as unknown as AgentManager;
}

const twoProjectCfg = (projects: Array<{ id: string; repo: string; mode?: 'git' | 'server' }>, review: BaxianConfig['review'] = { rounds: 2 }): BaxianConfig => ({
  review, server: DEFAULT_SERVER_CONFIG,
  project: projects.map(p => ({ id: p.id, repo: p.repo, merge: null, agent: [], review: { mode: p.mode ?? 'git' } })),
} as BaxianConfig);

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

  it('allows a drifted live identity to be restored to every active task binding', async () => {
    const manager = managerWithBound([{
      id: 'task-restore', projectId: 'proj', repoKey: 'github.com/owner/repo',
    }]);
    const current = config({
      repo: 'git@github.com:owner/drifted.git',
      review: { mode: 'server' },
      gitCli: { tool: 'forge' },
    });

    expect(await gitBindingBlockers(manager, current, config())).toEqual([]);
  });

  it.each([
    ['project task first', ['project-task', 'legacy-task']],
    ['legacy task first', ['legacy-task', 'project-task']],
  ])('allows a project to restore its own bound repo regardless of task scan order (%s)', async (_label, order) => {
    const tasks = {
      'project-task': { id: 'project-task', projectId: 'proj', repoKey: 'github.com/owner/repo' },
      'legacy-task': { id: 'legacy-task', projectId: 'legacy', repoKey: 'github.com/owner/repo' },
    } as const;
    const manager = managerWithBound(order.map(id => tasks[id as keyof typeof tasks]));
    const current = config({ review: { mode: 'server' } }, { rounds: 2, mode: 'server', afterDone: 'branch' });

    expect(await gitBindingBlockers(manager, current, config())).toEqual([]);
  });

  it('keeps blocking when a proposed identity restores only some active task bindings', async () => {
    const manager = managerWithBound([
      { id: 'task-restored', projectId: 'proj', repoKey: 'github.com/owner/repo' },
      { id: 'task-still-drifted', projectId: 'proj', repoKey: 'github.com/owner/other' },
    ]);
    const current = config({ repo: 'git@github.com:owner/drifted.git' });

    expect(await gitBindingBlockers(manager, current, config())).toEqual([
      { projectId: 'proj', taskIds: ['task-restored', 'task-still-drifted'] },
    ]);
  });

  it('blocks a NEW project newly pointing at a repo locked by another project\'s active tasks', async () => {
    const manager = managerWithBound([{ id: 'task-a', projectId: 'a', repoKey: 'github.com/owner/repo' }]);
    const current = twoProjectCfg([{ id: 'a', repo: 'git@github.com:owner/repo.git' }]);
    const next = twoProjectCfg([
      { id: 'a', repo: 'git@github.com:owner/repo.git' },
      { id: 'b', repo: 'https://github.com/owner/repo.git' },
    ]);
    expect(await gitBindingBlockers(manager, current, next)).toEqual([
      { projectId: 'b', taskIds: ['task-a'], lockedByProjectId: 'a' },
    ]);
  });

  it('allows a new server+branch project to share a repo because it creates no platform entry', async () => {
    const manager = managerWithBound([{ id: 'task-a', projectId: 'a', repoKey: 'github.com/owner/repo' }]);
    const review: BaxianConfig['review'] = { rounds: 2, mode: 'server', afterDone: 'branch' };
    const current = twoProjectCfg([
      { id: 'a', repo: 'git@github.com:owner/repo.git', mode: 'git' },
    ], review);
    const next = twoProjectCfg([
      { id: 'a', repo: 'git@github.com:owner/repo.git', mode: 'git' },
      { id: 'b', repo: 'https://github.com/owner/repo.git', mode: 'server' },
    ], review);

    expect(await gitBindingBlockers(manager, current, next)).toEqual([]);
  });

  it('blocks repointing an existing project onto a repo locked by another', async () => {
    const manager = managerWithBound([{ id: 'task-a', projectId: 'a', repoKey: 'github.com/owner/repo' }]);
    const current = twoProjectCfg([
      { id: 'a', repo: 'git@github.com:owner/repo.git' },
      { id: 'b', repo: 'git@github.com:owner/elsewhere.git' },
    ]);
    const next = twoProjectCfg([
      { id: 'a', repo: 'git@github.com:owner/repo.git' },
      { id: 'b', repo: 'https://github.com/owner/repo.git' },
    ]);
    expect(await gitBindingBlockers(manager, current, next)).toContainEqual({
      projectId: 'b', taskIds: ['task-a'], lockedByProjectId: 'a',
    });
  });

  it('attributes every owner when a new project targets a repo with legacy multi-owner bindings', async () => {
    const manager = managerWithBound([
      { id: 'task-b', projectId: 'b', repoKey: 'github.com/owner/repo' },
      { id: 'task-a', projectId: 'a', repoKey: 'github.com/owner/repo' },
    ]);
    const current = twoProjectCfg([
      { id: 'a', repo: 'git@github.com:owner/repo.git' },
      { id: 'b', repo: 'https://github.com/owner/repo.git' },
    ]);
    const next = twoProjectCfg([
      ...current.project.map(project => ({ id: project.id, repo: project.repo })),
      { id: 'c', repo: 'https://github.com/owner/repo.git' },
    ]);

    expect(await gitBindingBlockers(manager, current, next)).toEqual([
      { projectId: 'c', taskIds: ['task-a'], lockedByProjectId: 'a' },
      { projectId: 'c', taskIds: ['task-b'], lockedByProjectId: 'b' },
    ]);
  });

  it('blocks a no-entry project switching to a mode that occupies a locked shared repo', async () => {
    // A/B 都是 server+branch 共享 R(都不建 entry),A 有绑定 R 的 retained task;在线只把 B 切到 git。
    // B 自己无活动任务(①不拦),repo 字符串没变但 B 从「不占 entry」变成「占 entry」——②必须拦。
    const manager = managerWithBound([{ id: 'a', projectId: 'a', repoKey: 'github.com/owner/repo' }]);
    const server = (id: string): { id: string; repo: string; mode: 'server' } =>
      ({ id, repo: 'https://github.com/owner/repo.git', mode: 'server' });
    const current: BaxianConfig = {
      review: { rounds: 2, mode: 'server', afterDone: 'branch' }, server: DEFAULT_SERVER_CONFIG,
      project: [server('a'), server('b')].map(p => ({ id: p.id, repo: p.repo, merge: null, agent: [], review: { mode: p.mode } })),
    } as BaxianConfig;
    const next: BaxianConfig = {
      review: { rounds: 2, mode: 'server', afterDone: 'branch' }, server: DEFAULT_SERVER_CONFIG,
      project: [
        { id: 'a', repo: 'https://github.com/owner/repo.git', merge: null, agent: [], review: { mode: 'server' } },
        { id: 'b', repo: 'https://github.com/owner/repo.git', merge: null, agent: [], review: { mode: 'git' } },
      ],
    } as BaxianConfig;
    expect(await gitBindingBlockers(manager, current, next)).toEqual([
      { projectId: 'b', taskIds: ['a'], lockedByProjectId: 'a' },
    ]);
  });

  it('attributes cross-project repo-lock diagnostics to the changed project and names the lock owner', () => {
    expect(gitBindingBlockerDetails([{
      projectId: 'b', taskIds: ['task-a'], lockedByProjectId: 'a',
    }])).toEqual([{
      path: 'project.b.repo',
      message: 'repo is locked by active tasks in project a: task-a',
    }]);
  });

  it('does not block a project that already shared the locked repo', async () => {
    const manager = managerWithBound([{ id: 'task-a', projectId: 'a', repoKey: 'github.com/owner/repo' }]);
    const cfg = twoProjectCfg([
      { id: 'a', repo: 'git@github.com:owner/repo.git' },
      { id: 'b', repo: 'https://github.com/owner/repo.git' },
    ]);
    // b 在 current 已指向同 repo：这是既有状态,不是本次变更新引入的冲突
    expect(await gitBindingBlockers(manager, cfg, cfg)).toEqual([]);
  });
});

describe('activeParticipantBlockers', () => {
  type Seats = Array<{ taskId: string; projectId: string; participants: Array<{ agentId: string; expectedRole?: 'dev' | 'qa' | 'research' }> }>;
  const seatedManager = (seats: Seats): AgentManager =>
    ({ listActiveParticipantSeats: async () => seats } as unknown as AgentManager);

  const agentCfg = (projects: Array<{ id: string; agents: Array<{ id: string; role: 'dev' | 'qa' | 'research' }> }>): BaxianConfig => ({
    review: { rounds: 2 },
    server: DEFAULT_SERVER_CONFIG,
    project: projects.map(p => ({
      id: p.id, repo: `git@github.com:owner/${p.id}.git`, merge: null, review: { mode: 'git' as const },
      agent: [p.agents.map(a => ({ id: a.id, runtime: 'claude-code', role: a.role, mode: 'local', workdir: `/tmp/${a.id}` }))],
    })),
  } as BaxianConfig);

  const base = agentCfg([
    { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }, { id: 'qa-1', role: 'qa' }] },
    { id: 'other', agents: [] },
  ]);
  const qaSeat = (expectedRole: 'qa' | undefined = 'qa'): Seats =>
    [{ taskId: 'task-1', projectId: 'proj', participants: [{ agentId: 'qa-1', ...(expectedRole ? { expectedRole } : {}) }] }];

  it('blocks moving an active participant to another project', async () => {
    const next = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }] },
      { id: 'other', agents: [{ id: 'qa-1', role: 'qa' }] },
    ]);
    expect(await activeParticipantBlockers(seatedManager(qaSeat()), base, next)).toEqual([{
      projectId: 'proj', taskIds: ['task-1'], participantIds: ['qa-1'],
    }]);
  });

  it('blocks changing an active participant role in place', async () => {
    const next = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }, { id: 'qa-1', role: 'dev' }] },
      { id: 'other', agents: [] },
    ]);
    expect(await activeParticipantBlockers(seatedManager(qaSeat()), base, next)).toEqual([{
      projectId: 'proj', taskIds: ['task-1'], participantIds: ['qa-1'],
    }]);
  });

  it('blocks removing an active participant from the config', async () => {
    const next = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }] },
      { id: 'other', agents: [] },
    ]);
    expect(await activeParticipantBlockers(seatedManager(qaSeat()), base, next)).toEqual([{
      projectId: 'proj', taskIds: ['task-1'], participantIds: ['qa-1'],
    }]);
  });

  it('allows repairing a drifted role back to the seat the task expects', async () => {
    const drifted = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }, { id: 'qa-1', role: 'dev' }] },
      { id: 'other', agents: [] },
    ]);
    expect(await activeParticipantBlockers(seatedManager(qaSeat()), drifted, base)).toEqual([]);
  });

  it('allows repairing a participant drifted to another project back home', async () => {
    const drifted = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }] },
      { id: 'other', agents: [{ id: 'qa-1', role: 'qa' }] },
    ]);
    expect(await activeParticipantBlockers(seatedManager(qaSeat()), drifted, base)).toEqual([]);
  });

  it('blocks removing a participant whose seat had already drifted', async () => {
    const drifted = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }, { id: 'qa-1', role: 'dev' }] },
      { id: 'other', agents: [] },
    ]);
    const removed = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }] },
      { id: 'other', agents: [] },
    ]);
    expect(await activeParticipantBlockers(seatedManager(qaSeat()), drifted, removed)).toEqual([{
      projectId: 'proj', taskIds: ['task-1'], participantIds: ['qa-1'],
    }]);
  });

  it('blocks moving an already drifted participant to yet another wrong project', async () => {
    const drifted = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }] },
      { id: 'other', agents: [{ id: 'qa-1', role: 'qa' }] },
    ]);
    const driftedFurther = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }] },
      { id: 'other', agents: [] },
      { id: 'third', agents: [{ id: 'qa-1', role: 'qa' }] },
    ]);
    expect(await activeParticipantBlockers(seatedManager(qaSeat()), drifted, driftedFurther)).toEqual([{
      projectId: 'proj', taskIds: ['task-1'], participantIds: ['qa-1'],
    }]);
  });

  it('allows unrelated config changes while a seat is already drifted', async () => {
    const drifted = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }, { id: 'qa-1', role: 'dev' }] },
      { id: 'other', agents: [] },
    ]);
    const driftedPlus = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }, { id: 'qa-1', role: 'dev' }] },
      { id: 'other', agents: [{ id: 'qa-2', role: 'qa' }] },
    ]);
    expect(await activeParticipantBlockers(seatedManager(qaSeat()), drifted, driftedPlus)).toEqual([]);
  });

  it('passes mutations that only touch non-participant agents or other fields', async () => {
    const next = agentCfg([
      { id: 'proj', agents: [{ id: 'dev-1', role: 'dev' }, { id: 'qa-1', role: 'qa' }] },
      { id: 'other', agents: [{ id: 'qa-2', role: 'qa' }] },
    ]);
    const seats: Seats = [{ taskId: 'task-1', projectId: 'proj', participants: [
      { agentId: 'dev-1', expectedRole: 'dev' }, { agentId: 'qa-1', expectedRole: 'qa' },
    ] }];
    expect(await activeParticipantBlockers(seatedManager(seats), base, next)).toEqual([]);
  });

  it('leaves references that are already absent from the current config to the runtime alert layer', async () => {
    const seats: Seats = [{ taskId: 'task-1', projectId: 'proj', participants: [{ agentId: 'qa-gone', expectedRole: 'qa' }] }];
    expect(await activeParticipantBlockers(seatedManager(seats), base, base)).toEqual([]);
  });

  it('formats participant blockers with their own diagnostic path', () => {
    expect(gitBindingBlockerDetails([{
      projectId: 'proj', taskIds: ['task-1'], participantIds: ['qa-1'],
    }])).toEqual([{
      path: 'project.proj.agent',
      message: "active tasks pin their participants' role and project: task-1 (agents: qa-1)",
    }]);
  });
});
