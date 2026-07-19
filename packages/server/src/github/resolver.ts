import { BRANCH_PREFIX } from '../shared/index.js';
import type { AgentManager } from '../agent/manager.js';
import type { MappedEvent } from './mapper.js';

export interface ResolvedRouting {
  taskId?: string;
  agentId?: string;
}

export async function resolveEventRouting(
  manager: AgentManager,
  event: MappedEvent,
): Promise<ResolvedRouting> {
  const projectId = (manager.getProjectByRepo(event.repo) ?? manager.getProjectByRepoIdentity(event.repo))?.id;
  if (!projectId) return {};

  const branch = (event.data.branch as string | undefined) ?? '';
  const prNumber = event.data.prNumber as number | undefined;

  if (branch.startsWith(BRANCH_PREFIX)) {
    const taskId = branch.slice(BRANCH_PREFIX.length);
    const task = await manager.getTask(taskId);
    if (task && task.projectId === projectId) {
      return { taskId: task.id, agentId: task.agentId };
    }
  }

  if (branch) {
    const task = await manager.findTaskByBranch(branch, projectId);
    if (task) return { taskId: task.id, agentId: task.agentId };
  }

  if (typeof prNumber === 'number') {
    const tasks = await manager.listTasksByPrNumber(prNumber, projectId);
    if (tasks.length > 0) {
      return { taskId: tasks[0].id, agentId: tasks[0].agentId };
    }
  }

  return {};
}
