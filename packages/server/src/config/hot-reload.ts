import type { AppContext } from '../app.js';
import type { BaxianConfig, TaskState } from '../shared/index.js';
import {
  auditPlatformBindings,
  platformEntries,
  type PlatformBindingMismatch,
} from '../platform/startup.js';
import type { PlatformPollerEntryInit } from '../platform/platform-poller.js';

export interface ConfigHotReloadPlan {
  platform?: PlatformPollerEntryInit[];
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
  await auditPlatformBindings(
    validated,
    () => ctx.agentManager.listActiveGitTasks(),
    (task, mismatch) => { bindingMismatches.push({ task, mismatch }); },
  );
  return {
    platform: platformEntries(validated, ctx.platformEntryDeps),
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
  ctx.poller.reschedule(validated.server.platformPollIntervalMs);
  if (prepared.platform === undefined) return;
  ctx.poller.reconcile(prepared.platform);
  const activeInterventions = new Set<string>();
  for (const { task, mismatch } of prepared.bindingMismatches) {
    activeInterventions.add(ctx.agentManager.platformBindingInterventionKey(task, mismatch));
  }
  ctx.agentManager.retainPlatformBindingInterventionKeys(activeInterventions);
  for (const { task, mismatch } of prepared.bindingMismatches) {
    await ctx.agentManager.emitPlatformBindingIntervention(task, mismatch).catch(err => {
      console.warn('[config] platform-binding intervention emit failed:', err);
    });
  }
}
