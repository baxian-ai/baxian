import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { TextDecoder } from 'node:util';
import { AGENT_PHASES } from '../shared/index.js';
import type { AgentRole } from '../shared/index.js';

interface SkillFile {
  relPath: string;
  content: Buffer;
  text: string;
}

export interface SkillDef {
  name: string;
  dir: string;
  path: string;
  content: string;
  description: string;
  files: SkillFile[];
}

class SkillScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillScanError';
  }
}

const MAX_SKILL_FILE_BYTES = 100 * 1024;
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u;
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function decodeStrictUtf8(path: string, buf: Buffer): string {
  let text: string;
  try {
    text = utf8Strict.decode(buf);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillScanError(`${path}: invalid UTF-8 (${message})`);
  }
  if (ILLEGAL_XML.test(text)) {
    throw new SkillScanError(`${path}: contains XML-illegal control character`);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw new SkillScanError(
      `${path}: ${Buffer.byteLength(text, 'utf8')} bytes exceeds ${MAX_SKILL_FILE_BYTES} limit`,
    );
  }
  return text;
}

function parseSkillDescription(content: string): string {
  if (!content.startsWith('---\n')) return firstParagraph(content);
  const end = content.indexOf('\n---', 4);
  if (end === -1) return firstParagraph(content);
  const block = content.slice(4, end);
  for (const line of block.split('\n')) {
    const m = line.match(/^description:\s*(.*?)\s*$/);
    if (m) {
      return stripMatchedQuotes(m[1]);
    }
  }
  return firstParagraph(content.slice(end + 4));
}

function stripMatchedQuotes(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function firstParagraph(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const para = trimmed.split(/\n\s*\n/, 1)[0];
  return para.replace(/\s+/g, ' ').slice(0, 200);
}

// 仅顶层 skill 目录跟随 symlink；内部一律 lstat——后代链接可越界或成环，跟随会把外部内容物化进 Workdir。
async function walk(dir: string, base: string = dir): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // 静默跳过会把残缺 skill 标成功——不可遍历即整插件拒绝（usage-aware 层兜未引用插件）。
    throw new SkillScanError(`${dir}: unreadable skill directory (${err instanceof Error ? err.message : String(err)})`);
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    let s;
    try {
      s = await lstat(entryPath);
    } catch (err) {
      throw new SkillScanError(`${entryPath}: unreadable entry (${err instanceof Error ? err.message : String(err)})`);
    }
    if (s.isDirectory()) {
      out.push(...(await walk(entryPath, base)));
    } else if (s.isFile()) {
      const buf = await readFile(entryPath);
      const text = decodeStrictUtf8(entryPath, buf);
      out.push({
        relPath: relative(base, entryPath),
        content: buf,
        text,
      });
    }
  }
  return out;
}

export interface SkillScope {
  pluginTools: string[];
}

export class SkillRegistry {
  private skills = new Map<string, SkillDef>();
  private pluginSkills = new Map<string, SkillDef[]>();
  constructor(private skillsDir?: string) {}

  async scan(): Promise<void> {
    this.skills.clear();
    if (!this.skillsDir) return;
    for (const def of await scanSkillRoot(this.skillsDir)) {
      this.skills.set(def.name, def);
    }
  }

  // 与核心同名即整插件抛错（原子淘汰，池不留半截）——只删单个 skill 会留下引用它的残缺插件。
  async scanPluginSkills(tool: string, skillsRoot: string): Promise<void> {
    const defs = await scanSkillRoot(skillsRoot);
    for (const def of defs) {
      if (this.skills.has(def.name)) {
        throw new SkillScanError(`plugin '${tool}' skill '${def.name}' collides with a core skill`);
      }
    }
    this.pluginSkills.set(tool, defs);
  }

  private scopedDefs(scope?: SkillScope): SkillDef[] {
    const defs = [...this.skills.values()];
    for (const tool of scope?.pluginTools ?? []) {
      defs.push(...(this.pluginSkills.get(tool) ?? []));
    }
    return defs;
  }

  pluginSkillNames(scope?: SkillScope): string[] {
    return (scope?.pluginTools ?? []).flatMap(
      (tool) => (this.pluginSkills.get(tool) ?? []).map((d) => d.name),
    );
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  get(name: string): SkillDef | undefined {
    return this.skills.get(name);
  }

  names(): string[] {
    return [...this.skills.keys()];
  }

  skillsForPhase(role: AgentRole, phase: string): string[] {
    const phases = AGENT_PHASES[role];
    if (!phases) return [];
    const phaseConfig = phases[phase as keyof typeof phases];
    if (!phaseConfig) return [];
    return phaseConfig.skills.filter((name) => this.skills.has(name));
  }

  async materialize(write: SkillFileWriter, destRoot: string, scope?: SkillScope): Promise<string[]> {
    const written: string[] = [];
    for (const def of this.scopedDefs(scope)) {
      for (const file of def.files) {
        const path = join(destRoot, def.name, file.relPath);
        await write(path, file.content);
        written.push(path);
      }
    }
    return written;
  }

  contentHash(scope?: SkillScope): string {
    const h = createHash('sha256');
    const defs = [...this.scopedDefs(scope)].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const def of defs) {
      h.update(def.name).update('\0');
      for (const file of [...def.files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
        h.update(file.relPath).update('\0').update(file.content).update('\0');
      }
    }
    return h.digest('hex').slice(0, 16);
  }
}

async function scanSkillRoot(root: string): Promise<SkillDef[]> {
  const defs: SkillDef[] = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return defs;
  }
  for (const entry of entries) {
    // 与插件加载器同候选集：隐藏目录与非 baxian- 前缀不入池——物化清理只回收 baxian-*，
    // 越集注入的目录无法清理。
    if (entry.startsWith('.') || !entry.startsWith('baxian-')) continue;
    const entryPath = join(root, entry);
    let s;
    try {
      s = await stat(entryPath);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    const skillFile = join(entryPath, 'SKILL.md');
    let skillStat;
    try {
      skillStat = await lstat(skillFile);
    } catch {
      continue;
    }
    if (!skillStat.isFile()) continue;
    let skillBuf: Buffer;
    try {
      skillBuf = await readFile(skillFile);
    } catch {
      continue;
    }
    const skillMd = decodeStrictUtf8(skillFile, skillBuf);
    const files = await walk(entryPath);
    defs.push({
      name: entry,
      dir: entryPath,
      path: skillFile,
      content: skillMd,
      description: parseSkillDescription(skillMd),
      files,
    });
  }
  return defs;
}

export type SkillFileWriter = (path: string, content: Buffer) => Promise<void>;

const CORE_SKILLS = ['baxian-greeting', 'baxian-signals'] as const;

export function assertCoreSkillsPresent(registry: SkillRegistry, skillsDir?: string): void {
  const missing = CORE_SKILLS.filter((name) => !registry.has(name));
  if (missing.length === 0) return;
  const detail =
    registry.names().length === 0
      ? `skill registry is EMPTY (skillsDir=${skillsDir ?? 'unset'}) — skills/ was dropped from the bundle or the path is wrong`
      : `skill registry is missing core skill(s): ${missing.join(', ')}`;
  throw new Error(
    `${detail} — the greeting gate and signal dispatch require ${CORE_SKILLS.join(' + ')}`,
  );
}
