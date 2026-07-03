import type { AgentSnapshot, TaskState, ProjectConfig } from '../../src/shared/index.js';

export function makeAgent(id = 'dev-1', overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    projectId: 'proj',
    runtimeStatus: 'idle',
    tmuxSessionStatus: 'present',
    stale: false,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const now = '2026-06-29T10:00:00Z';
  return {
    id: 'task-001',
    projectId: 'proj',
    title: 'A task',
    description: '',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    reviewRound: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj',
    repo: 'https://github.com/o/r.git',
    merge: null,
    agent: [],
    ...overrides,
  };
}
