import type { AgentSnapshot, TaskState, ProjectConfig, AgentRuntime } from '../../src/shared/index.js';
import type { ProbeResponse } from '../../src/api.ts';

type ProbeRuntimes = ProbeResponse['runtimes'];
type ProbeStatus = ProbeRuntimes[AgentRuntime];

// Full four-runtime probe.runtimes so tests never miss a key when a new AgentRuntime is added.
export function makeRuntimes(
  overrides: Partial<Record<AgentRuntime, ProbeStatus>> = {},
  fallback: ProbeStatus = { ok: true, message: '' },
): ProbeRuntimes {
  return {
    'claude-code': overrides['claude-code'] ?? fallback,
    codex: overrides.codex ?? fallback,
    opencode: overrides.opencode ?? fallback,
    qodercli: overrides.qodercli ?? fallback,
  };
}

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
    devAgentId: 'dev-1',
    phase: 'code',
    reviewMode: 'git',
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
