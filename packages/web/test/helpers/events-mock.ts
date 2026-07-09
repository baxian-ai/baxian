import { vi } from 'vitest';

type EventsModule = typeof import('../../src/hooks/use-events.ts');

export const useAgentsMock = vi.fn();
export const useTaskMock = vi.fn();
export const useProjectTasksMock = vi.fn();

export function createEventsMock(): EventsModule {
  return {
    useAgents: useAgentsMock,
    useTask: useTaskMock,
    useProjectTasks: useProjectTasksMock,
  };
}
