import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { TextDecoder } from 'node:util';
import { AGENT_PHASES } from '../shared/index.js';
import type { AgentRole } from '../shared/index.js';

export interface SkillFile {
  relPath: string;
  content: Buffer;
  // UTF-8-decoded text; binaries are rejected at scan.
  text: string;
}

export interface SkillDef {
  name: string;
  dir: string;
  path: string;
  content: string;
  // Frontmatter `description` field; empty string when missing.
  description: string;
  files: SkillFile[];
}

export class SkillScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillScanError';
  }
}

const MAX_SKILL_FILE_BYTES = 100 * 1024;
// XML 1.0 illegal control chars (tab/LF/CR valid; everything else in 0x00-0x1F is not).
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

// Narrow frontmatter parser: pulls a single-line `description: <value>` from the
// leading `---\n...\n---` block. Avoids a full YAML dependency.
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

async function walk(dir: string, base: string = dir): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    let s;
    try {
      s = await lstat(entryPath);
    } catch {
      continue; // race: entry removed between readdir and lstat
    }
    // lstat, not stat: our skills are regular files only — a symlink/special
    // file isn't ours, so skip it rather than follow it out of the tree.
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

export class SkillRegistry {
  private skills = new Map<string, SkillDef>();
  // skillsDir holds the package-shipped skills (npm packaging puts them next to dist).
  constructor(private skillsDir?: string) {}

  async scan(): Promise<void> {
    this.skills.clear();
    if (!this.skillsDir) return;
    let entries: string[];
    try {
      entries = await readdir(this.skillsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(this.skillsDir, entry);
      let s;
      try {
        s = await lstat(entryPath);
      } catch {
        continue; // race: entry removed between readdir and lstat
      }
      // lstat skips a symlinked dir too: a skill dir must be a real directory we own.
      if (!s.isDirectory()) continue;
      const skillFile = join(entryPath, 'SKILL.md');
      let skillStat;
      try {
        skillStat = await lstat(skillFile);
      } catch {
        continue; // no SKILL.md, or race
      }
      // SKILL.md must be a real file we own. A symlink would register the skill
      // (readFile follows it) while walk() skips it, so materialize() never writes
      // it out — a registered-but-unmaterialized skill the agent can't discover.
      if (!skillStat.isFile()) continue;
      let skillBuf: Buffer;
      try {
        skillBuf = await readFile(skillFile);
      } catch {
        continue;
      }
      const skillMd = decodeStrictUtf8(skillFile, skillBuf);
      const files = await walk(entryPath);
      this.skills.set(entry, {
        name: entry,
        dir: entryPath,
        path: skillFile,
        content: skillMd,
        description: parseSkillDescription(skillMd),
        files,
      });
    }
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

  // Write every scanned skill (SKILL.md + helper files) under destRoot/<name>/<relPath>
  // so the agent host's `claude`/`codex` REPL discovers them as native skills. `write`
  // abstracts the transport (CommandRunner.writeFile for SSH/local) so this stays
  // decoupled from the agent layer. Returns the absolute file paths written.
  async materialize(write: SkillFileWriter, destRoot: string): Promise<string[]> {
    const written: string[] = [];
    for (const def of this.skills.values()) {
      for (const file of def.files) {
        const path = join(destRoot, def.name, file.relPath);
        await write(path, file.content);
        written.push(path);
      }
    }
    return written;
  }

  // Stable digest of all scanned skill content. The on-host version marker compares
  // against it so a redeploy with edited skills re-materializes, an unchanged one skips.
  contentHash(): string {
    const h = createHash('sha256');
    for (const name of [...this.skills.keys()].sort()) {
      const def = this.skills.get(name)!;
      h.update(name).update('\0');
      for (const file of [...def.files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
        h.update(file.relPath).update('\0').update(file.content).update('\0');
      }
    }
    return h.digest('hex').slice(0, 16);
  }
}

export type SkillFileWriter = (path: string, content: Buffer) => Promise<void>;
