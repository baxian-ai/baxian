import { repoIdentityKey, TASK_TERMINAL_STATUS_SET, type BaxianConfig, type ProjectConfig, type TaskState } from '../shared/index.js';
import type { PlatformPollerEntryInit } from './platform-poller.js';
import type { PlatformDriver } from './types.js';

export interface PlatformEntryDeps {
  driverFor: (project: ProjectConfig) => PlatformDriver;
  statePathFor: (repoUrl: string) => string;
}

export interface PlatformBindingMismatch {
  reason: 'missing-binding-snapshot' | 'project-missing' | 'identity-mismatch';
  differences: Array<'project' | 'repoKey'>;
  binding?: NonNullable<TaskState['platformBinding']>;
  live?: { repoKey: string };
}

export function taskNeedsPlatformBindingAudit(task: TaskState): boolean {
  return task.platformBinding !== undefined
    || task.remoteCleanup !== undefined
    || !TASK_TERMINAL_STATUS_SET.has(task.status);
}

export function platformBindingMismatch(
  config: BaxianConfig,
  task: TaskState,
): PlatformBindingMismatch | undefined {
  if (!taskNeedsPlatformBindingAudit(task)) return undefined;
  const binding = task.platformBinding;
  if (binding === undefined) {
    return { reason: 'missing-binding-snapshot', differences: ['repoKey'] };
  }
  const project = config.project.find(candidate => candidate.id === task.projectId);
  if (project === undefined) {
    return { reason: 'project-missing', differences: ['project'], binding };
  }
  const live = {
    repoKey: repoIdentityKey(project.repo),
  };
  const differences: PlatformBindingMismatch['differences'] = [];
  if (binding.repoKey !== live.repoKey) differences.push('repoKey');
  return differences.length === 0
    ? undefined
    : { reason: 'identity-mismatch', differences, binding, live };
}

export function platformEntries(
  config: BaxianConfig,
  deps: PlatformEntryDeps,
): PlatformPollerEntryInit[] {
  return config.project.map(project => ({
    projectId: project.id,
    repoUrl: project.repo,
    driver: deps.driverFor(project),
    statePath: deps.statePathFor(project.repo),
  }));
}

export async function auditPlatformBindings(
  config: BaxianConfig,
  listActivePlatformTasks: () => Promise<TaskState[]>,
  onBindingMismatch?: (task: TaskState, mismatch: PlatformBindingMismatch) => void | Promise<void>,
): Promise<void> {
  for (const task of await listActivePlatformTasks()) {
    if (TASK_TERMINAL_STATUS_SET.has(task.status) || !taskNeedsPlatformBindingAudit(task)) continue;
    const mismatch = platformBindingMismatch(config, task);
    if (mismatch !== undefined) await onBindingMismatch?.(task, mismatch);
  }
}
