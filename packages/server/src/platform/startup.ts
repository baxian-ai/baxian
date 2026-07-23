import { join } from 'node:path';
import { PluginRegistry, type PluginDiagnostic, type LoadedPlugin } from './plugin-registry.js';
import { builtinPluginRoot, userPluginRoot } from './plugin-roots.js';
import { repoIdentityKey, TASK_TERMINAL_STATUS_SET, type BaxianConfig, type ProjectConfig, type TaskState } from '../shared/index.js';
import { projectNeedsPlatformEntry, projectReviewMode, resolveProjectTool } from '../config/validator.js';
import type { PlatformDriver, PlatformPollerEntryInit } from './platform-poller.js';

export async function loadPluginsOrExplainWithRoots(
  config: BaxianConfig,
  roots: { builtin: string; user: string },
): Promise<{ registry: PluginRegistry } | { fatal: string[] }> {
  const { registry, diagnostics } = await PluginRegistry.load(roots);
  const describe = (d: PluginDiagnostic) => `plugin at ${d.pluginPath}: ${d.messages.join('; ')}`;
  const fatal: string[] = [];

  // fatal 判定收敛两条（spec v2 §5.4）：
  // ① 内置根是随包分发内容，任何坏损即装机损坏（终态内置集合 = {github}，「根内任一坏损」≡「github 坏损」）；
  for (const d of diagnostics) {
    if (d.source === 'builtin') fatal.push(describe(d));
  }

  // ② 某项目 resolved tool 的插件缺失或坏损。坏损用户插件占用的 tool 不静默回退内置——回退会掩盖覆盖意图；
  // 被覆盖内置的 tool 由加载器按覆盖键（manifest.name）标注在诊断上，此处只做裁决。
  const poisonedByTool = new Map<string, string>();
  for (const d of diagnostics) {
    if (d.source !== 'user') continue;
    if (d.tool !== undefined && !poisonedByTool.has(d.tool)) {
      poisonedByTool.set(d.tool, describe(d));
    }
    if (d.overriddenBuiltinTool !== undefined && !poisonedByTool.has(d.overriddenBuiltinTool)) {
      poisonedByTool.set(
        d.overriddenBuiltinTool,
        `user plugin '${d.name}' overrides the builtin provider of tool '${d.overriddenBuiltinTool}' but is unusable — ${describe(d)}`,
      );
    }
  }
  for (const project of config.project.filter(candidate => projectNeedsPlatformEntry(config, candidate))) {
    const tool = resolveProjectTool(project);
    if (tool === undefined) continue; // 非 github 且缺 gitCli：validator 已报配置错误
    const poisoned = poisonedByTool.get(tool);
    if (poisoned !== undefined) {
      fatal.push(`project '${project.id}': git-driver plugin for tool '${tool}' failed to load — ${poisoned}`);
    } else if (!registry.resolveTool(tool)) {
      fatal.push(
        `project '${project.id}': no git-driver plugin provides tool '${tool}'. ` +
        `Install one under ~/.baxian/plugins/<name>/ (searched user root: ${roots.user}; builtin root: ${roots.builtin}).`,
      );
    }
  }
  if (fatal.length > 0) return { fatal };

  // 未被任何项目引用的用户插件坏损：警告 + 跳过，不得清空有效集合（§5.4）。
  for (const d of diagnostics) console.warn(`[PluginRegistry] skipped ${describe(d)}`);
  return { registry };
}

export function referencedGitTools(config: BaxianConfig): Set<string> {
  const tools = new Set<string>();
  for (const project of config.project) {
    if (projectReviewMode(config, project) !== 'git') continue;
    const tool = resolveProjectTool(project);
    if (tool !== undefined) tools.add(tool);
  }
  return tools;
}

// skill 池扫描沿加载期同一部分成功模型：未引用用户插件坏损警告跳过，内置或被引用插件坏损才拖垮启动。
export async function scanPluginSkillPools(
  skillRegistry: { scanPluginSkills(tool: string, skillsRoot: string): Promise<void> },
  plugins: LoadedPlugin[],
  referencedTools: ReadonlySet<string>,
): Promise<void> {
  for (const plugin of plugins) {
    try {
      await skillRegistry.scanPluginSkills(plugin.manifest.tool, join(plugin.pluginPath, 'skills'));
    } catch (err) {
      if (plugin.source === 'builtin' || referencedTools.has(plugin.manifest.tool)) throw err;
      console.warn(
        `[startup] plugin '${plugin.manifest.name}' skill pool skipped (not referenced by any project): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function loadPluginsOrExplain(
  config: BaxianConfig,
): Promise<{ registry: PluginRegistry } | { fatal: string[] }> {
  return loadPluginsOrExplainWithRoots(config, { builtin: builtinPluginRoot(), user: userPluginRoot() });
}

export interface PlatformEntryDeps {
  driverFor: (project: ProjectConfig) => PlatformDriver | undefined;
  statePathFor: (repoUrl: string) => string;
  retainedProjectIds?: ReadonlySet<string>;
}

export interface PlatformEntryPlan {
  entries: PlatformPollerEntryInit[];
  // 离线绕过在线锁后，同 repo 的第二个项目在此暴露为冲突：其 entry 不建、由调用方发
  // repo-conflict intervention，受保护项目（先 claim 者）的 entry 保留（spec §5.5）。
  conflicts: Array<{ projectId: string; repoKey: string; claimedBy: string }>;
}

export interface PlatformBindingMismatch {
  reason: 'missing-binding-snapshot' | 'project-missing' | 'identity-mismatch';
  differences: Array<'project' | 'mode' | 'repoKey' | 'tool'>;
  binding?: NonNullable<TaskState['platformBinding']>;
  live?: { mode: string; repoKey: string; tool: string };
}

export function taskNeedsPlatformBindingAudit(task: TaskState): boolean {
  return task.reviewMode === 'git' || task.afterDone === 'pr' || task.platformBinding !== undefined;
}

export function platformBindingMismatch(
  config: BaxianConfig,
  task: TaskState,
): PlatformBindingMismatch | undefined {
  if (!taskNeedsPlatformBindingAudit(task)) return undefined;
  const binding = task.platformBinding;
  if (binding === undefined) {
    return { reason: 'missing-binding-snapshot', differences: ['mode', 'repoKey', 'tool'] };
  }
  const project = config.project.find(candidate => candidate.id === task.projectId);
  if (project === undefined) {
    return { reason: 'project-missing', differences: ['project'], binding };
  }
  const live = {
    mode: projectReviewMode(config, project),
    repoKey: repoIdentityKey(project.repo),
    tool: resolveProjectTool(project) ?? '',
  };
  const differences: PlatformBindingMismatch['differences'] = [];
  if (binding.mode !== live.mode) differences.push('mode');
  if (binding.repoKey !== live.repoKey) differences.push('repoKey');
  if (binding.tool !== live.tool) differences.push('tool');
  return differences.length === 0
    ? undefined
    : { reason: 'identity-mismatch', differences, binding, live };
}

// entry 集合按 repo 身份去重（spec §4/§5.5 同谓词）：同 repo 的多个项目共用一个 cursor 与观察缓存。
// retained（有活动任务但配置已不需 entry）项目优先 claim,确保受保护任务的 entry 保留、冲突落到
// 后来的项目上。
export function planPlatformEntries(
  config: BaxianConfig,
  deps: PlatformEntryDeps,
): PlatformEntryPlan {
  const entries: PlatformPollerEntryInit[] = [];
  const conflicts: PlatformEntryPlan['conflicts'] = [];
  const claimedBy = new Map<string, string>();
  const retainedFirst = [
    ...config.project.filter(p => deps.retainedProjectIds?.has(p.id)),
    ...config.project.filter(p => !deps.retainedProjectIds?.has(p.id)),
  ];
  for (const project of retainedFirst) {
    if (!projectNeedsPlatformEntry(config, project) && !deps.retainedProjectIds?.has(project.id)) continue;
    const key = repoIdentityKey(project.repo);
    const owner = claimedBy.get(key);
    if (owner !== undefined) {
      conflicts.push({ projectId: project.id, repoKey: key, claimedBy: owner });
      continue;
    }
    const driver = deps.driverFor(project);
    if (driver === undefined) {
      console.warn(
        `[startup] project '${project.id}' needs a platform entry but tool '${resolveProjectTool(project) ?? '<unresolved>'}' has no usable plugin — skipped`,
      );
      continue;
    }
    claimedBy.set(key, project.id);
    entries.push({ projectId: project.id, repoUrl: project.repo, driver, statePath: deps.statePathFor(project.repo) });
  }
  return { entries, conflicts };
}

// 配置改到不再需要 entry 时，仍在飞的任务不能失去轮询（PR 已开、裁决还没回）：
// 按任务快照保留，与 live 配置解耦，任务转终态后下一次 reconcile 自然拆除。
export async function retainedPlatformProjectIds(
  config: BaxianConfig,
  listActivePlatformTasks: () => Promise<TaskState[]>,
  onBindingMismatch?: (task: TaskState, mismatch: PlatformBindingMismatch) => void | Promise<void>,
): Promise<Set<string>> {
  const retained = new Set<string>();
  const projects = new Map(config.project.map(project => [project.id, project]));
  for (const task of await listActivePlatformTasks()) {
    if (TASK_TERMINAL_STATUS_SET.has(task.status) || !taskNeedsPlatformBindingAudit(task)) continue;
    const mismatch = platformBindingMismatch(config, task);
    if (mismatch !== undefined) {
      await onBindingMismatch?.(task, mismatch);
      continue;
    }
    const project = projects.get(task.projectId)!;
    if (!projectNeedsPlatformEntry(config, project)) retained.add(project.id);
  }
  return retained;
}
