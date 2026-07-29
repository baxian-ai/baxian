import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginRegistry } from '../../src/platform/plugin-registry.js';
import { MANIFEST, DRIVER } from './plugin-fixtures.js';

async function writePlugin(
  root: string,
  dirName: string,
  tool: string,
  opts: {
    skill?: boolean;
    skillName?: string;
    name?: string;
    skillMd?: string;
    extraSkills?: Array<{ dir: string; frontmatterName?: string }>;
  } = {},
) {
  const p = join(root, dirName);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, 'baxian-plugin.json'), MANIFEST(tool, opts.name));
  await writeFile(join(p, 'driver.json'), DRIVER);
  if (opts.skill !== false) {
    const skillDir = join(p, 'skills', opts.skillName ?? `baxian-cli-${tool}`);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      opts.skillMd ?? `---\nname: ${opts.skillName ?? `baxian-cli-${tool}`}\ndescription: ops manual\n---\nbody`,
    );
  }
  for (const extra of opts.extraSkills ?? []) {
    const dir = join(p, 'skills', extra.dir);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${extra.frontmatterName ?? extra.dir}\ndescription: extra\n---\nbody`,
    );
  }
  return p;
}

async function createRoots() {
  const base = await mkdtemp(join(tmpdir(), 'bx-plugins-'));
  const builtin = join(base, 'builtin');
  const user = join(base, 'user');
  await mkdir(builtin, { recursive: true });
  await mkdir(user, { recursive: true });
  return { builtin, user, base };
}

describe('PluginRegistry', () => {
  let roots: { builtin: string; user: string; base: string };

  beforeEach(async () => {
    roots = await createRoots();
  });

  afterEach(async () => {
    if (roots?.base) await rm(roots.base, { recursive: true, force: true });
  });

  it('rejects a symlinked SKILL.md at load time instead of leaving a never-materialized skill', async () => {
    const pluginPath = await writePlugin(roots.builtin, 'forge', 'forge', { skill: false });
    const real = join(roots.base, 'real-skill.md');
    await writeFile(real, '---\nname: baxian-cli-forge\ndescription: linked\n---\nbody');
    const skillDir = join(pluginPath, 'skills', 'baxian-cli-forge');
    await mkdir(skillDir, { recursive: true });
    await symlink(real, join(skillDir, 'SKILL.md'));
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('forge')).toBeUndefined();
    expect(res.diagnostics.some(d => d.messages.some(m => m.includes('must be a regular file')))).toBe(true);
  });

  it('loads a valid plugin and resolves by tool, with no diagnostics', async () => {
    await writePlugin(roots.builtin, 'glab', 'glab');
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('glab')?.source).toBe('builtin');
    expect(res.diagnostics).toEqual([]);
  });

  it('missing baxian-cli-<tool> skill dir surfaces a diagnostic with plugin path and identity', async () => {
    const p = await writePlugin(roots.builtin, 'forge', 'forge', { skill: false });
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('forge')).toBeUndefined();
    const d = res.diagnostics.find(d => d.pluginPath === p);
    expect(d).toBeDefined();
    expect(d!.tool).toBe('forge');
    expect(d!.messages.join('\n')).toMatch(/baxian-cli-forge/);
  });

  it('skill frontmatter name mismatch excludes the plugin via diagnostic', async () => {
    await writePlugin(roots.builtin, 'forge', 'forge', { skillName: 'baxian-forge' });
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('forge')).toBeUndefined();
    expect(res.diagnostics.length).toBeGreaterThan(0);
  });

  it('user root overrides builtin for the same plugin name', async () => {
    await writePlugin(roots.builtin, 'glab', 'glab');
    await writePlugin(roots.user, 'glab', 'glab');
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('glab')?.source).toBe('user');
    expect(res.diagnostics).toEqual([]);
  });

  it('user override declaring a different tool is diagnosed; the builtin stays in the set', async () => {
    await writePlugin(roots.builtin, 'glab', 'glab');
    await writePlugin(roots.user, 'glab', 'forge', { name: 'glab' });
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('glab')?.source).toBe('builtin');
    expect(res.registry.resolveTool('forge')).toBeUndefined();
    const d = res.diagnostics.find(d => /must keep the same tool/.test(d.messages.join(' ')));
    expect(d).toBeDefined();
    expect(d!.tool).toBe('forge');
    expect(d!.overriddenBuiltinTool).toBe('glab');
  });

  it('a symlinked skill directory is followed, matching root-level symlink handling', async () => {
    const p = await writePlugin(roots.builtin, 'glab', 'glab', { skill: false });
    const realDir = join(roots.base, 'real-skill');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'SKILL.md'), '---\nname: baxian-cli-glab\ndescription: d\n---\nbody');
    await mkdir(join(p, 'skills'), { recursive: true });
    await symlink(realDir, join(p, 'skills', 'baxian-cli-glab'));
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('glab')?.skillNames).toContain('baxian-cli-glab');
  });

  it('dot-directories (.git etc.) are not plugin candidates and do not poison the registry', async () => {
    await writePlugin(roots.user, 'glab', 'glab');
    await mkdir(join(roots.user, '.git', 'objects'), { recursive: true });
    await mkdir(join(roots.user, 'glab', 'skills', '.cache'), { recursive: true });
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('glab')?.source).toBe('user');
    expect(res.diagnostics).toEqual([]);
  });

  it('a UTF-8 BOM on manifest/driver/SKILL.md is stripped, not reported as invalid JSON', async () => {
    const p = await writePlugin(roots.builtin, 'glab', 'glab');
    const bom = '﻿';
    await writeFile(join(p, 'baxian-plugin.json'), bom + MANIFEST('glab'));
    await writeFile(join(p, 'driver.json'), bom + DRIVER);
    await writeFile(
      join(p, 'skills', 'baxian-cli-glab', 'SKILL.md'),
      bom + '---\nname: baxian-cli-glab\ndescription: d\n---\nbody',
    );
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('glab')).toBeDefined();
    expect(res.diagnostics).toEqual([]);
  });

  it('a dangling skill symlink yields a diagnostic, not a silent skip', async () => {
    const p = await writePlugin(roots.builtin, 'glab', 'glab');
    await symlink(join(roots.base, 'nowhere'), join(p, 'skills', 'baxian-glab-extra'));
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('glab')).toBeUndefined();
    expect(res.diagnostics.some(d => /cannot resolve skills\/baxian-glab-extra/.test(d.messages.join('\n')))).toBe(true);
  });

  it('two plugins claiming the same tool keep the first and diagnose the second', async () => {
    await writePlugin(roots.builtin, 'glab', 'glab');
    await writePlugin(roots.user, 'glab2', 'glab', { name: 'glab2' });
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('glab')?.source).toBe('builtin');
    expect(res.diagnostics.some(d => /provided by both/.test(d.messages.join(' ')))).toBe(true);
  });

  it('empty roots load an empty registry (github-only deployments unaffected)', async () => {
    const res = await PluginRegistry.load(roots);
    expect(res.registry.all().length).toBe(0);
    expect(res.diagnostics).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('unreadable plugin manifest yields a diagnostic without identity', async () => {
    const p = await writePlugin(roots.builtin, 'forge', 'forge');
    const manifestPath = join(p, 'baxian-plugin.json');
    await chmod(manifestPath, 0o000);
    try {
      const res = await PluginRegistry.load(roots);
      const d = res.diagnostics.find(d => d.pluginPath === p);
      expect(d).toBeDefined();
      expect(d!.tool).toBeUndefined();
      expect(res.registry.resolveTool('forge')).toBeUndefined();
    } finally {
      await chmod(manifestPath, 0o755);
    }
  });

  it('accepts CRLF frontmatter with a quoted name', async () => {
    await writePlugin(roots.builtin, 'forge', 'forge', {
      skillMd: '---\r\nname: "baxian-cli-forge"\r\ndescription: ops manual\r\n---\r\nbody',
    });
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('forge')?.source).toBe('builtin');
    expect(res.diagnostics).toEqual([]);
  });

  it('same-source duplicate names keep the lexicographically first dir and diagnose the second', async () => {
    const p1 = await writePlugin(roots.builtin, 'dir-a', 'toolx', { name: 'shared' });
    const p2 = await writePlugin(roots.builtin, 'dir-b', 'tooly', { name: 'shared' });
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('toolx')?.pluginPath).toBe(p1);
    expect(res.registry.resolveTool('tooly')).toBeUndefined();
    expect(res.diagnostics.some(d => d.messages.join(' ').includes(p1) && d.messages.join(' ').includes(p2))).toBe(true);
  });

  it('a plugin root that is not a directory (ENOTDIR) yields a root diagnostic, not a rejection', async () => {
    await writePlugin(roots.builtin, 'glab', 'glab');
    const res = await PluginRegistry.load({ builtin: roots.builtin, user: '/dev/null' });
    expect(res.registry.resolveTool('glab')).toBeDefined();
    const d = res.diagnostics.find(d => d.pluginPath === '/dev/null');
    expect(d).toBeDefined();
    expect(d!.messages.join('\n')).toMatch(/ENOTDIR/);
  });

  it('an attached skill dir without the baxian- prefix excludes the plugin', async () => {
    const p = await writePlugin(roots.builtin, 'forge', 'forge', {
      extraSkills: [{ dir: 'extra-thing' }],
    });
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('forge')).toBeUndefined();
    expect(res.diagnostics.some(d => d.pluginPath === p && /extra-thing/.test(d.messages.join('\n')))).toBe(true);
  });

  it('an attached skill with mismatched frontmatter name excludes the plugin', async () => {
    const p = await writePlugin(roots.builtin, 'forge', 'forge', {
      extraSkills: [{ dir: 'baxian-extra', frontmatterName: 'baxian-extra-wrong' }],
    });
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('forge')).toBeUndefined();
    expect(res.diagnostics.some(d => d.pluginPath === p && /baxian-extra/.test(d.messages.join('\n')))).toBe(true);
  });

  it('a legit attached skill is exposed via skillNames', async () => {
    await writePlugin(roots.builtin, 'forge', 'forge', {
      extraSkills: [{ dir: 'baxian-extra' }],
    });
    const res = await PluginRegistry.load(roots);
    const plugin = res.registry.resolveTool('forge');
    expect(plugin?.skillNames).toEqual(expect.arrayContaining(['baxian-cli-forge', 'baxian-extra']));
  });

  it('two plugins providing the same attached skill keep the first and diagnose the second with both paths', async () => {
    const p1 = await writePlugin(roots.builtin, 'forge', 'forge', {
      extraSkills: [{ dir: 'baxian-shared-skill' }],
    });
    const p2 = await writePlugin(roots.user, 'glab', 'glab', {
      extraSkills: [{ dir: 'baxian-shared-skill' }],
    });
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('forge')).toBeDefined();
    expect(res.registry.resolveTool('glab')).toBeUndefined();
    expect(res.diagnostics.some(d => d.messages.join(' ').includes(p1) && d.messages.join(' ').includes(p2))).toBe(true);
  });

  it('a dangling symlink entry does not take down the rest of the root', async () => {
    await writePlugin(roots.builtin, 'glab', 'glab');
    const deadPath = join(roots.builtin, 'dead');
    await symlink('/nonexistent', deadPath);
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('glab')).toBeDefined();
    expect(res.diagnostics.length).toBe(1);
    expect(res.diagnostics[0].pluginPath).toBe(deadPath);
  });

  it('a parseable manifest failing schema validation still yields diagnostic identity', async () => {
    const p = join(roots.user, 'bad-schema');
    await mkdir(p, { recursive: true });
    await writeFile(join(p, 'baxian-plugin.json'), JSON.stringify({
      name: 'gh', version: '', kind: 'git-driver', tool: 'forge', minToolVersion: '1.0.0', driverSchema: 1,
    }));
    const res = await PluginRegistry.load(roots);
    const d = res.diagnostics.find(d => d.pluginPath === p)!;
    expect(d.name).toBe('gh');
    expect(d.tool).toBe('forge');
  });

  it('a broken plugin surfaces as a diagnostic with best-effort identity; valid siblings stay loaded', async () => {
    await writePlugin(roots.user, 'good', 'good');
    const p = await writePlugin(roots.user, 'bad', 'bad');
    await rm(join(p, 'driver.json'));
    const res = await PluginRegistry.load(roots);
    expect(res.registry.resolveTool('good')).toBeDefined();
    expect(res.registry.resolveTool('bad')).toBeUndefined();
    const d = res.diagnostics.find(d => d.pluginPath === p)!;
    expect(d.tool).toBe('bad');
    expect(d.source).toBe('user');
    expect(d.messages.join('\n')).toMatch(/driver\.json not found/);
  });
});
