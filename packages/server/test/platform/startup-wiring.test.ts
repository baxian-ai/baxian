import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPluginsOrExplainWithRoots, referencedGitTools, scanPluginSkillPools } from '../../src/platform/startup.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { MANIFEST, DRIVER } from './plugin-fixtures.js';

const cfgWith = (projects: unknown[]) => ({
  review: { rounds: 3 }, server: { port: 3000, host: '127.0.0.1' }, host: [], project: projects,
}) as never;

async function writeValidPlugin(root: string, tool: string, name = tool): Promise<string> {
  const p = join(root, tool);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, 'baxian-plugin.json'), MANIFEST(tool, name));
  await writeFile(join(p, 'driver.json'), DRIVER);
  const skillDir = join(p, 'skills', `baxian-cli-${tool}`);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: baxian-cli-${tool}\ndescription: ops manual\n---\nbody`);
  return p;
}

const tmpRoots: string[] = [];
async function createRoots(): Promise<{ builtin: string; user: string }> {
  const base = await mkdtemp(join(tmpdir(), 'bx-startup-'));
  tmpRoots.push(base);
  const builtin = join(base, 'builtin');
  const user = join(base, 'user');
  await mkdir(builtin, { recursive: true });
  await mkdir(user, { recursive: true });
  return { builtin, user };
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('loadPluginsOrExplainWithRoots', () => {
  it('a github project with no plugin root available is fatal (it resolves tool gh like any git project)', async () => {
    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://github.com/a/b.git', merge: null, agent: [] },
    ]), { builtin: '/nonexistent-a', user: '/nonexistent-b' });
    expect('fatal' in r).toBe(true);
    expect((r as { fatal: string[] }).fatal.join('\n')).toMatch(/no git-driver plugin provides tool 'gh'/);
  });

  it('a project with an unresolvable tool is fatal with an install hint', async () => {
    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://gl.example.com/g/p.git', merge: null, gitCli: { tool: 'forge' }, agent: [] },
    ]), { builtin: '/nonexistent-a', user: '/nonexistent-b' });
    expect('fatal' in r).toBe(true);
    const msg = (r as { fatal: string[] }).fatal.join('\n');
    expect(msg).toMatch(/forge/);
    expect(msg).toMatch(/\.baxian\/plugins/);
  });

  it('a project with a resolvable tool returns a registry', async () => {
    const roots = await createRoots();
    await writeValidPlugin(roots.builtin, 'glab');
    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://gl.example.com/g/p.git', merge: null, gitCli: { tool: 'glab' }, agent: [] },
    ]), roots);
    expect('registry' in r).toBe(true);
    expect((r as { registry: { resolveTool: (t: string) => unknown } }).registry.resolveTool('glab')).toBeTruthy();
  });

  it('a broken plugin in the BUILTIN root is fatal even for a github-only config (corrupt install)', async () => {
    const roots = await createRoots();
    const broken = join(roots.builtin, 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'baxian-plugin.json'), MANIFEST('broken'));
    // deliberately no driver.json — triggers PluginRegistry's "driver.json not found"

    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'gh', repo: 'https://github.com/a/b.git', merge: null, agent: [] },
    ]), roots);
    expect('fatal' in r).toBe(true);
    expect((r as { fatal: string[] }).fatal.join('\n')).toMatch(/driver\.json not found/);
  });

  it('a broken UNREFERENCED plugin in the user root warns and is skipped; other plugins stay loaded', async () => {
    const roots = await createRoots();
    await writeValidPlugin(roots.builtin, 'glab');
    const broken = join(roots.user, 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'baxian-plugin.json'), MANIFEST('broken'));

    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://gl.example.com/g/p.git', merge: null, review: { mode: 'git' }, gitCli: { tool: 'glab' }, agent: [] },
    ]), roots);
    expect('registry' in r).toBe(true);
    expect((r as { registry: { resolveTool: (t: string) => unknown } }).registry.resolveTool('glab')).toBeTruthy();
  });

  it('a broken user plugin whose tool a git project resolves is fatal (no silent builtin fallback)', async () => {
    const roots = await createRoots();
    await writeValidPlugin(roots.builtin, 'glab');
    const broken = join(roots.user, 'override');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'baxian-plugin.json'), MANIFEST('glab'));

    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://gl.example.com/g/p.git', merge: null, review: { mode: 'git' }, gitCli: { tool: 'glab' }, agent: [] },
    ]), roots);
    expect('fatal' in r).toBe(true);
    const msg = (r as { fatal: string[] }).fatal.join('\n');
    expect(msg).toMatch(/glab/);
    expect(msg).toMatch(/failed to load/);
  });

  it('a loaded same-name override declaring a different tool poisons the overridden builtin tool (fatal when referenced)', async () => {
    const roots = await createRoots();
    await writeValidPlugin(roots.builtin, 'gh');
    await writeValidPlugin(roots.user, 'forge', 'gh');
    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://github.com/a/b.git', merge: null, review: { mode: 'git' }, agent: [] },
    ]), roots);
    expect('fatal' in r).toBe(true);
    const msg = (r as { fatal: string[] }).fatal.join('\n');
    expect(msg).toMatch(/failed to load/);
    expect(msg).toMatch(/overrides the builtin provider/);
  });

  it('a BROKEN same-name override (manifest parseable, different tool) also poisons the builtin tool', async () => {
    const roots = await createRoots();
    await writeValidPlugin(roots.builtin, 'gh');
    const broken = join(roots.user, 'override');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'baxian-plugin.json'), JSON.stringify({
      name: 'gh', version: '1.0.0', kind: 'git-driver', tool: 'forge', minToolVersion: '1.0.0', driverSchema: 1,
    }));
    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://github.com/a/b.git', merge: null, review: { mode: 'git' }, agent: [] },
    ]), roots);
    expect('fatal' in r).toBe(true);
    expect((r as { fatal: string[] }).fatal.join('\n')).toMatch(/overrides the builtin provider/);
  });

  it('a same-name override whose manifest parses but fails schema validation still poisons the builtin tool', async () => {
    const roots = await createRoots();
    await writeValidPlugin(roots.builtin, 'gh');
    const broken = join(roots.user, 'override');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'baxian-plugin.json'), JSON.stringify({
      name: 'gh', version: '', kind: 'git-driver', tool: 'forge', minToolVersion: '1.0.0', driverSchema: 1,
    }));
    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://github.com/a/b.git', merge: null, review: { mode: 'git' }, agent: [] },
    ]), roots);
    expect('fatal' in r).toBe(true);
    expect((r as { fatal: string[] }).fatal.join('\n')).toMatch(/overrides the builtin provider/);
  });

  it('an UNPARSEABLE-manifest user dir cannot be linked to an override and stays a warning (documented boundary)', async () => {
    const roots = await createRoots();
    await writeValidPlugin(roots.builtin, 'gh');
    const garbage = join(roots.user, 'github');
    await mkdir(garbage, { recursive: true });
    await writeFile(join(garbage, 'baxian-plugin.json'), '{oops');
    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://github.com/a/b.git', merge: null, review: { mode: 'git' }, agent: [] },
    ]), roots);
    expect('registry' in r).toBe(true);
    expect((r as { registry: { resolveTool: (t: string) => unknown } }).registry.resolveTool('gh')).toBeTruthy();
  });

  it("a github repo in mode 'git' auto-resolves tool 'gh'", async () => {
    const roots = await createRoots();
    await writeValidPlugin(roots.builtin, 'gh');
    const ok = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://github.com/a/b.git', merge: null, review: { mode: 'git' }, agent: [] },
    ]), roots);
    expect('registry' in ok).toBe(true);

    const missing = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://github.com/a/b.git', merge: null, review: { mode: 'git' }, agent: [] },
    ]), { builtin: '/nonexistent-a', user: '/nonexistent-b' });
    expect('fatal' in missing).toBe(true);
    expect((missing as { fatal: string[] }).fatal.join('\n')).toMatch(/'gh'/);
  });

  it('git project with a broken plugin root is fatal with plugin path and reason', async () => {
    const roots = await createRoots();
    const broken = join(roots.builtin, 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'baxian-plugin.json'), MANIFEST('broken'));
    // deliberately no driver.json — triggers PluginRegistry's "driver.json not found"

    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'p', repo: 'https://gl.example.com/g/p.git', merge: null, review: { mode: 'git' }, gitCli: { tool: 'glab' }, agent: [] },
    ]), roots);
    expect('fatal' in r).toBe(true);
    const msg = (r as { fatal: string[] }).fatal.join('\n');
    expect(msg).toMatch(/broken/);
    expect(msg).toMatch(/driver\.json not found/);
  });

  it('collects one fatal reason per unresolved-tool project without short-circuiting', async () => {
    const roots = await createRoots();
    await writeValidPlugin(roots.builtin, 'glab');
    const r = await loadPluginsOrExplainWithRoots(cfgWith([
      { id: 'ok', repo: 'https://gl.example.com/g/ok.git', merge: null, review: { mode: 'git' }, gitCli: { tool: 'glab' }, agent: [] },
      { id: 'bad1', repo: 'https://gl.example.com/g/bad1.git', merge: null, review: { mode: 'git' }, gitCli: { tool: 'forge' }, agent: [] },
      { id: 'bad2', repo: 'https://gl.example.com/g/bad2.git', merge: null, review: { mode: 'git' }, gitCli: { tool: 'hub' }, agent: [] },
      { id: 'gh', repo: 'https://github.com/a/b.git', merge: null, agent: [] },
    ]), roots);
    expect('fatal' in r).toBe(true);
    const fatal = (r as { fatal: string[] }).fatal;
    expect(fatal).toHaveLength(3);
    const joined = fatal.join('\n');
    expect(joined).toMatch(/'gh'/);
    expect(joined).toMatch(/bad1/);
    expect(joined).toMatch(/forge/);
    expect(joined).toMatch(/bad2/);
    expect(joined).toMatch(/hub/);
  });
});


describe('scanPluginSkillPools', () => {
  async function loadedPlugins(roots: { builtin: string; user: string }) {
    const r = await loadPluginsOrExplainWithRoots(cfgWith([]), roots);
    if ('fatal' in r) throw new Error(r.fatal.join('\n'));
    return r.registry.all();
  }

  it('skips an unreferenced user plugin whose auxiliary file is broken instead of killing startup', async () => {
    const roots = await createRoots();
    const pluginPath = await writeValidPlugin(roots.user, 'forge');
    await writeFile(join(pluginPath, 'skills', 'baxian-cli-forge', 'bad.bin'), Buffer.from([0xff]));
    const healthy = await writeValidPlugin(roots.user, 'glab');
    void healthy;
    const registry = new SkillRegistry();
    await registry.scan();
    const plugins = await loadedPlugins(roots);
    await scanPluginSkillPools(registry, plugins, new Set());
    expect(registry.pluginSkillNames({ pluginTools: ['forge'] })).toEqual([]);
    expect(registry.pluginSkillNames({ pluginTools: ['glab'] })).toEqual(['baxian-cli-glab']);
  });

  it('fails startup when the broken plugin is referenced by a project', async () => {
    const roots = await createRoots();
    const pluginPath = await writeValidPlugin(roots.user, 'forge');
    await writeFile(join(pluginPath, 'skills', 'baxian-cli-forge', 'bad.bin'), Buffer.from([0xff]));
    const registry = new SkillRegistry();
    await registry.scan();
    const plugins = await loadedPlugins(roots);
    await expect(scanPluginSkillPools(registry, plugins, new Set(['forge']))).rejects.toThrow(/invalid UTF-8/);
  });

  it('resolves referenced tools from every project', () => {
    const cfg = cfgWith([
      { id: 'a', repo: 'https://gl.example.com/g/a.git', merge: null, gitCli: { tool: 'glab' }, agent: [] },
      { id: 'b', repo: 'https://github.com/o/r.git', merge: null, agent: [] },
      { id: 'c', repo: 'https://gl.example.com/g/c.git', merge: null, gitCli: { tool: 'forge' }, agent: [] },
    ]);
    expect([...referencedGitTools(cfg)].sort()).toEqual(['forge', 'gh', 'glab']);
  });
});

describe('git recovery wiring', () => {
  it('runs recovery before event registration and includes both durable sweeps in maintenance', async () => {
    const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(source.indexOf('await agentManager.recover()'))
      .toBeLessThan(source.indexOf('registerEventHandlers(eventBus, agentManager)'));
    expect(source).toMatch(/name: 'GitMaintenance'[\s\S]*retryPendingGitReviewDispatches\(\)[\s\S]*retryGitRemoteCleanupIntents\(\)/);
  });

  it('starts durable sweeps directly without legacy migrations', async () => {
    const source = await readFile(new URL('../../src/agent/manager.ts', import.meta.url), 'utf8');
    const recover = source.slice(source.indexOf('async recover(): Promise<void>'));
    expect(recover).not.toContain('migrateLegacyGit');
    expect(recover).toContain('retryGitRemoteCleanupIntents()');
    expect(recover).toContain('recoverClaimedGitReviewDispatches()');
  });
});
