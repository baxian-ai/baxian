import type { AppContext } from '../app.js';
import type { BaxianConfig } from '../shared/index.js';
import { pollerStatePathFor } from '../github/poller.js';

// Single entry point for "config swapped — propagate to live subsystems."
// Both POST /projects and the non-restart branch of PATCH /config go through
// here; new stateful subsystems only need to be added in one place.
export function applyConfigHotReload(ctx: AppContext, validated: BaxianConfig): void {
  ctx.agentManager.replaceConfig(validated);
  ctx.tmuxProbePoller?.replaceConfig(validated);
  ctx.bootstrapPoller?.replaceConfig(validated);
  const stateDir = ctx.stateDir;
  ctx.poller?.replaceConfig(validated, {
    statePathFor: stateDir
      ? (project) => pollerStatePathFor(stateDir, project.repo)
      : undefined,
  });
}
