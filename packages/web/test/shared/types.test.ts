import { describe, it, expect } from 'vitest';
import { isAgentDispatching, type AgentSnapshot } from '../../src/shared/index.js';

type Binding = NonNullable<AgentSnapshot['binding']>;

function makeAgent(binding: Binding | undefined, tmuxSessionStatus: AgentSnapshot['tmuxSessionStatus'] = 'present'): AgentSnapshot {
  return {
    id: 'dev-1', projectId: 'proj', runtimeStatus: 'idle', tmuxSessionStatus, stale: false, binding,
  };
}

function makeBinding(overrides: Partial<Binding> = {}): Binding {
  return {
    id: 'dev-1', projectId: 'proj', taskId: 'task-1', bootstrappingTaskId: 'task-1',
    updatedAt: '2026-05-16T00:00:00.000Z', ...overrides,
  };
}

describe('isAgentDispatching', () => {
  it.each(['present', 'absent', 'unknown'] as const)(
    'is true while the marker matches the bound task, whatever the session status (%s), and scopes to a task id',
    tmuxSessionStatus => {
      expect(isAgentDispatching(makeAgent(makeBinding(), tmuxSessionStatus))).toBe(true);
      expect(isAgentDispatching(makeAgent(makeBinding(), tmuxSessionStatus), 'task-1')).toBe(true);
      expect(isAgentDispatching(makeAgent(makeBinding(), tmuxSessionStatus), 'task-2')).toBe(false);
    },
  );

  it.each([
    ['the marker is missing', makeBinding({ bootstrappingTaskId: undefined })],
    ['there is no binding at all', undefined],
    ['the marker no longer matches the bound task', makeBinding({ taskId: 'task-2' })],
    ['the binding lost its task', makeBinding({ taskId: undefined })],
    ['the binding is held for a human', makeBinding({ status: 'awaiting_human' })],
    ['a question awaits an answer', makeBinding({
      needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: '2026-07-06T10:00:00Z' },
    })],
  ] as const)('is false when %s', (_desc, binding) => {
    expect(isAgentDispatching(makeAgent(binding as Binding | undefined))).toBe(false);
  });
});
