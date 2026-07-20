import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { parseManifest, type ManifestIdentity } from './manifest.js';
import { parseDriverSpec } from './driver-spec.js';
import type { DriverSpec, PluginManifest, PluginValidationError } from './types.js';

export interface LoadedPlugin {
  manifest: PluginManifest;
  spec: DriverSpec;
  pluginPath: string;
  skillDir: string;
  skillNames: string[];
  source: 'builtin' | 'user';
}

// 坏损插件的逐插件诊断（spec v2 §5.4 部分成功模型）；name/tool 是 best-effort 身份——
// manifest 解析成功而后续失败时携带，供 startup 判定「项目 resolved tool 被坏损插件占用」。
// overriddenBuiltinTool：覆盖键是 manifest.name，同名坏损用户插件即内置插件的覆盖版——
// 加载器在此标注被覆盖内置的 tool，startup 只做 fatal 裁决、不重建键规则。
export interface PluginDiagnostic {
  pluginPath: string;
  source: 'builtin' | 'user';
  name?: string;
  tool?: string;
  overriddenBuiltinTool?: string;
  messages: string[];
}

function frontmatterName(skillMd: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!m) return undefined;
  const line = m[1].split(/\r?\n/).find(l => l.startsWith('name:'));
  if (line === undefined) return undefined;
  const raw = line.slice('name:'.length).trim();
  const quoted =
    raw.length >= 2 &&
    ((raw[0] === '"' && raw[raw.length - 1] === '"') || (raw[0] === "'" && raw[raw.length - 1] === "'"));
  return quoted ? raw.slice(1, -1) : raw;
}

async function readPluginFile(
  path: string,
  pluginPath: string,
  label: string,
): Promise<{ content: string | undefined } | { errors: PluginValidationError[] }> {
  try {
    const raw = await readFile(path, 'utf-8');
    // Windows 编辑器常给文件加 BOM；不剥则 JSON.parse/frontmatter 匹配失败且报错指向"JSON 非法"，误导。
    return { content: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { content: undefined };
    return { errors: [{ pluginPath, message: `cannot read ${label}: ${(e as NodeJS.ErrnoException).message}` }] };
  }
}

function toDiagnostic(
  pluginPath: string,
  source: 'builtin' | 'user',
  errors: PluginValidationError[],
  identity?: ManifestIdentity,
): { diagnostic: PluginDiagnostic } {
  return {
    diagnostic: {
      pluginPath,
      source,
      name: identity?.name,
      tool: identity?.tool,
      messages: errors.map(e => e.message),
    },
  };
}

async function loadOne(
  pluginPath: string,
  source: 'builtin' | 'user',
): Promise<{ plugin: LoadedPlugin } | { diagnostic: PluginDiagnostic }> {
  const errors: PluginValidationError[] = [];
  const manifestR = await readPluginFile(join(pluginPath, 'baxian-plugin.json'), pluginPath, 'baxian-plugin.json');
  if ('errors' in manifestR) return toDiagnostic(pluginPath, source, manifestR.errors);
  if (manifestR.content === undefined) {
    return toDiagnostic(pluginPath, source, [{ pluginPath, message: 'baxian-plugin.json not found' }]);
  }
  const mr = parseManifest(manifestR.content, pluginPath);
  if ('errors' in mr) return toDiagnostic(pluginPath, source, mr.errors, mr);

  // driver.json 与 skills/ 互不依赖：两边的错误聚合后一次性返回，插件作者不必多轮试错（manifest 因决定 tool 名仍短路）。
  const driverR = await readPluginFile(join(pluginPath, 'driver.json'), pluginPath, 'driver.json');
  let spec: DriverSpec | undefined;
  if ('errors' in driverR) {
    errors.push(...driverR.errors);
  } else if (driverR.content === undefined) {
    errors.push({ pluginPath, message: 'driver.json not found' });
  } else {
    const dr = parseDriverSpec(driverR.content, pluginPath);
    if ('errors' in dr) errors.push(...dr.errors);
    else spec = dr.spec;
  }

  const requiredSkillName = `baxian-cli-${mr.manifest.tool}`;
  const skillsRoot = join(pluginPath, 'skills');
  const skillsScan = await readdirSafe(skillsRoot);
  if ('error' in skillsScan) {
    errors.push({ pluginPath, message: `cannot scan skills dir: ${skillsScan.error.message}` });
  }
  const skillNames: string[] = [];
  for (const entry of 'entries' in skillsScan ? skillsScan.entries : []) {
    if (entry.name.startsWith('.')) continue;
    const dir = await direntIsDir(skillsRoot, entry);
    if ('error' in dir) {
      errors.push({ pluginPath, message: `cannot resolve skills/${entry.name}: ${dir.error.message}` });
      continue;
    }
    if (!dir.isDir) continue;
    const name = entry.name;
    if (!name.startsWith('baxian-')) {
      errors.push({ pluginPath, message: `skill dir 'skills/${name}' must be prefixed 'baxian-'` });
      continue;
    }
    // 物化扫描（skill/registry）对 skill 内部一律 lstat 不跟随；加载期接受 symlink SKILL.md
    // 会造出「插件有效但必需 skill 永不物化」的静默空洞，在此拒绝。
    const skillMdPath = join(skillsRoot, name, 'SKILL.md');
    try {
      if ((await lstat(skillMdPath)).isSymbolicLink()) {
        errors.push({ pluginPath, message: `skills/${name}/SKILL.md must be a regular file (a symlink is never materialized)` });
        continue;
      }
    } catch {
      // 缺失走下方统一的 not found 诊断
    }
    const skillR = await readPluginFile(skillMdPath, pluginPath, `skills/${name}/SKILL.md`);
    if ('errors' in skillR) {
      errors.push(...skillR.errors);
      continue;
    }
    if (skillR.content === undefined) {
      errors.push({ pluginPath, message: `skills/${name}/SKILL.md not found` });
    } else if (frontmatterName(skillR.content) !== name) {
      errors.push({ pluginPath, message: `skills/${name}/SKILL.md frontmatter name must be '${name}'` });
    } else {
      skillNames.push(name);
    }
  }
  if (!skillNames.includes(requiredSkillName)) {
    errors.push({ pluginPath, message: `required agent-half skill missing: skills/${requiredSkillName}/SKILL.md` });
  }
  if (errors.length > 0 || spec === undefined) return toDiagnostic(pluginPath, source, errors, mr.manifest);
  const skillDir = join(skillsRoot, requiredSkillName);
  return { plugin: { manifest: mr.manifest, spec, pluginPath, skillDir, skillNames, source } };
}

async function readdirSafe(dir: string): Promise<{ entries: Dirent[] } | { error: NodeJS.ErrnoException }> {
  try {
    return { entries: await readdir(dir, { withFileTypes: true }) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
    return { error: e as NodeJS.ErrnoException };
  }
}

// withFileTypes 不跟随 symlink——统一 stat 判定，否则 ln -s 的插件/skill 目录被静默跳过。
async function direntIsDir(
  parent: string,
  entry: Dirent,
): Promise<{ isDir: boolean } | { error: NodeJS.ErrnoException }> {
  if (entry.isDirectory()) return { isDir: true };
  if (!entry.isSymbolicLink()) return { isDir: false };
  try {
    return { isDir: (await stat(join(parent, entry.name))).isDirectory() };
  } catch (e) {
    return { error: e as NodeJS.ErrnoException };
  }
}

async function scanRoot(
  root: string,
  source: 'builtin' | 'user',
): Promise<{ dirs: string[]; errors: PluginValidationError[] }> {
  const scan = await readdirSafe(root);
  if ('error' in scan) {
    return { dirs: [], errors: [{ pluginPath: root, message: `cannot scan ${source} plugin root: ${scan.error.message}` }] };
  }
  const entries = scan.entries;
  const dirs: string[] = [];
  const errors: PluginValidationError[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // .git/.vscode 等版本管理/编辑器目录不是插件候选
    const p = join(root, entry.name);
    const dir = await direntIsDir(root, entry);
    if ('error' in dir) {
      errors.push({
        pluginPath: p,
        message: `cannot resolve ${source} plugin entry: ${dir.error.message}`,
      });
      continue;
    }
    if (dir.isDir) dirs.push(p);
  }
  return { dirs, errors };
}

export class PluginRegistry {
  private constructor(private readonly byTool: Map<string, LoadedPlugin>) {}

  static async load(
    roots: { builtin: string; user: string },
  ): Promise<{ registry: PluginRegistry; diagnostics: PluginDiagnostic[] }> {
    const diagnostics: PluginDiagnostic[] = [];
    const pluginDiag = (plugin: LoadedPlugin, message: string) => {
      diagnostics.push({
        pluginPath: plugin.pluginPath,
        source: plugin.source,
        name: plugin.manifest.name,
        tool: plugin.manifest.tool,
        messages: [message],
      });
    };
    const byName = new Map<string, LoadedPlugin>();
    for (const source of ['builtin', 'user'] as const) {
      const scan = await scanRoot(roots[source], source);
      for (const e of scan.errors) {
        diagnostics.push({ pluginPath: e.pluginPath, source, messages: [e.message] });
      }
      // readdir 顺序无契约；重名/冲突「先到先得」需要确定性，按目录名排序。
      scan.dirs.sort();
      // 插件目录彼此独立，同根内并行加载；结果按目录序回填，override/重名检测的顺序语义不变。
      const results = await Promise.all(scan.dirs.map(pluginPath => loadOne(pluginPath, source)));
      for (const r of results) {
        if ('diagnostic' in r) {
          diagnostics.push(r.diagnostic);
          continue;
        }
        const plugin = r.plugin;
        const prev = byName.get(plugin.manifest.name);
        if (prev) {
          if (prev.source === source) {
            pluginDiag(plugin, `duplicate plugin name '${plugin.manifest.name}': ${prev.pluginPath} and ${plugin.pluginPath}`);
            continue;
          }
          // override 的语义是用户 fork 修正同一插件（spec §5.4）；换 tool 的同名插件会把内置 tool 静默移出注册表。
          if (prev.manifest.tool !== plugin.manifest.tool) {
            pluginDiag(plugin, `user plugin '${plugin.manifest.name}' declares tool '${plugin.manifest.tool}' but overrides a builtin providing tool '${prev.manifest.tool}'; an override must keep the same tool`);
            continue;
          }
          console.warn(`[PluginRegistry] user plugin overrides builtin: ${plugin.manifest.name} (${plugin.pluginPath})`);
        }
        byName.set(plugin.manifest.name, plugin);
      }
    }
    // 冲突淘汰以插件为原子单位（不半载）：与核心 skills 的冲突检查留给 M3 SkillRegistry 接线，此处只查插件间。
    const skillOwners = new Map<string, LoadedPlugin>();
    const byTool = new Map<string, LoadedPlugin>();
    for (const plugin of byName.values()) {
      const skillClash = plugin.skillNames.find(name => skillOwners.has(name));
      if (skillClash !== undefined) {
        pluginDiag(plugin, `skill '${skillClash}' provided by both ${skillOwners.get(skillClash)!.pluginPath} and ${plugin.pluginPath}`);
        continue;
      }
      for (const name of plugin.skillNames) skillOwners.set(name, plugin);
      // tool 唯一性由必需 skill baxian-cli-<tool> 的唯一性蕴含（loadOne 强制），此处无需再查冲突。
      byTool.set(plugin.manifest.tool, plugin);
    }
    for (const d of diagnostics) {
      if (d.source !== 'user' || d.name === undefined) continue;
      const shadowed = byName.get(d.name);
      if (shadowed?.source === 'builtin') d.overriddenBuiltinTool = shadowed.manifest.tool;
    }
    return { registry: new PluginRegistry(byTool), diagnostics };
  }

  resolveTool(tool: string): LoadedPlugin | undefined {
    return this.byTool.get(tool);
  }

  all(): LoadedPlugin[] {
    return [...this.byTool.values()];
  }
}
