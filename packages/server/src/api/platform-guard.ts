import type { BaxianConfig } from '../shared/types.js';
import { projectReviewMode, resolveProjectTool } from '../config/validator.js';
import { repoIdentityKey } from '../shared/git-url.js';
import type { AgentManager } from '../agent/manager.js';

function identityTrio(
  config: BaxianConfig,
  projectId: string,
): { mode: string; repoKey: string; tool: string } | undefined {
  const project = config.project.find(p => p.id === projectId);
  if (!project) return undefined;
  return {
    mode: projectReviewMode(config, project),
    repoKey: repoIdentityKey(project.repo),
    tool: resolveProjectTool(project) ?? '',
  };
}

// 活动任务配置锁（spec §4，'git' 范围；server+afterDone 'pr' 谓词扩展留 M3c）：
// 身份三元组 (effective mode, 归一化 repo, resolved tool) 变更在存在非终态 'git' 任务时被拒。
export async function gitBindingBlockers(
  manager: AgentManager,
  current: BaxianConfig,
  next: BaxianConfig,
): Promise<Array<{ projectId: string; taskIds: string[] }>> {
  const blockers: Array<{ projectId: string; taskIds: string[] }> = [];
  for (const project of current.project) {
    const before = identityTrio(current, project.id);
    const after = identityTrio(next, project.id);
    if (before !== undefined && after !== undefined
      && before.mode === after.mode && before.repoKey === after.repoKey && before.tool === after.tool) {
      continue;
    }
    // 锁范围由实际活动 TaskState 决定：离线漂移后 live mode 可能已非 git，但非终态 git 任务
    // 仍持有旧 binding——身份变化/删除一律查任务，不得让漂移把项目移出保护范围
    const tasks = await manager.listActiveGitTasks(project.id);
    if (tasks.length > 0) blockers.push({ projectId: project.id, taskIds: tasks.map(t => t.id) });
  }
  return blockers;
}
