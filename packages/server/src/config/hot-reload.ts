import type { AppContext } from '../app.js';
import type { BaxianConfig, TaskState } from '../shared/index.js';
import {
  planPlatformEntries,
  retainedPlatformProjectIds,
  type PlatformBindingMismatch,
  type PlatformEntryPlan,
} from '../platform/startup.js';

export interface ConfigHotReloadPlan {
  platform?: PlatformEntryPlan;
  bindingMismatches: Array<{ task: TaskState; mismatch: PlatformBindingMismatch }>;
}

export async function prepareConfigHotReload(
  ctx: AppContext,
  validated: BaxianConfig,
): Promise<ConfigHotReloadPlan> {
  if (ctx.poller === undefined || ctx.platformEntryDeps === undefined) {
    return { bindingMismatches: [] };
  }
  const bindingMismatches: ConfigHotReloadPlan['bindingMismatches'] = [];
  const retainedProjectIds = await retainedPlatformProjectIds(
    validated,
    () => ctx.agentManager.listActiveGitTasks(),
    (task, mismatch) => { bindingMismatches.push({ task, mismatch }); },
  );
  return {
    platform: planPlatformEntries(validated, { ...ctx.platformEntryDeps, retainedProjectIds }),
    bindingMismatches,
  };
}

export async function applyConfigHotReload(
  ctx: AppContext,
  validated: BaxianConfig,
  prepared: ConfigHotReloadPlan,
): Promise<void> {
  ctx.agentManager.replaceConfig(validated);
  ctx.tmuxProbePoller?.replaceConfig(validated);
  ctx.bootstrapPoller?.replaceConfig(validated);
  ctx.dispatchReconciler?.replaceConfig(validated);
  if (ctx.poller === undefined) return;
  // pollIntervalMs 是非重启字段：PATCH 后运行中的 poller 必须立即改用新间隔,否则 API 声称
  // 「已应用」而实际直到进程重启才生效。
  ctx.poller.reschedule(validated.server.githubPollIntervalMs);
  if (prepared.platform === undefined) return;
  ctx.poller.reconcile(prepared.platform.entries);
  const activeInterventions = new Set<string>();
  for (const { task, mismatch } of prepared.bindingMismatches) {
    activeInterventions.add(ctx.agentManager.platformBindingInterventionKey(task, mismatch));
  }
  for (const conflict of prepared.platform.conflicts) {
    activeInterventions.add(ctx.agentManager.configInterventionKey(conflict.projectId, {
      phase: 'repo-conflict', repoKey: conflict.repoKey, claimedBy: conflict.claimedBy,
    }));
  }
  ctx.agentManager.retainConfigInterventionKeys(activeInterventions);
  for (const { task, mismatch } of prepared.bindingMismatches) {
    await ctx.agentManager.emitPlatformBindingIntervention(task, mismatch).catch(err => {
      console.warn('[config] platform-binding intervention emit failed:', err);
    });
  }
  // 离线编辑绕过在线锁后重载：同 repo 冲突项目发 repo-conflict intervention（spec §5.5），
  // 与 startup 路径一致（index.ts）——受保护项目 entry 已在 plan.entries 中保留。
  for (const conflict of prepared.platform.conflicts) {
    await ctx.agentManager.emitConfigIntervention(conflict.projectId, {
      phase: 'repo-conflict', repoKey: conflict.repoKey, claimedBy: conflict.claimedBy,
    }).catch(err => console.warn('[config] repo-conflict intervention emit failed:', err));
  }
}
