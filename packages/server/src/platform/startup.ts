import { PluginRegistry, type PluginDiagnostic } from './plugin-registry.js';
import { builtinPluginRoot, userPluginRoot } from './plugin-roots.js';
import type { BaxianConfig } from '../shared/index.js';
import { projectReviewMode, resolveProjectTool } from '../config/validator.js';

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
  for (const project of config.project) {
    if (projectReviewMode(config, project) !== 'git') continue;
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

export function loadPluginsOrExplain(
  config: BaxianConfig,
): Promise<{ registry: PluginRegistry } | { fatal: string[] }> {
  return loadPluginsOrExplainWithRoots(config, { builtin: builtinPluginRoot(), user: userPluginRoot() });
}
