import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginRegistry } from '../../src/platform/plugin-registry.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { AgentManager } from '../../src/agent/manager.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { BaxianConfig } from '../../src/shared/index.js';

let base = '';
let registry: SkillRegistry;

async function seedSkillDir(root: string, name: string, body: string, extra: Record<string, string> = {}): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), body);
  for (const [rel, content] of Object.entries(extra)) {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bx-skill-scope-'));
  const core = join(base, 'core');
  await mkdir(core, { recursive: true });
  await seedSkillDir(core, 'baxian-signals', 'signals stub');
  await seedSkillDir(core, 'baxian-task-check', 'task-check stub');
  registry = new SkillRegistry(core);
  await registry.scan();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function seedPlugin(tool: string, body = `${tool} ops manual`): Promise<string> {
  const skillsRoot = join(base, `plugin-${tool}`, 'skills');
  await seedSkillDir(skillsRoot, `baxian-cli-${tool}`, body, { 'references/extra.md': 'ref' });
  await registry.scanPluginSkills(tool, skillsRoot);
  return skillsRoot;
}

describe('SkillRegistry plugin scope', () => {
  it('materializes core plus only the scoped tool plugin skills', async () => {
    await seedPlugin('gh');
    await seedPlugin('forge');
    const written: string[] = [];
    const write = async (path: string): Promise<void> => { written.push(path); };
    const scoped = await registry.materialize(write, '/dest', { pluginTools: ['gh'] });
    expect(scoped.some(p => p.includes('/dest/baxian-cli-gh/SKILL.md'))).toBe(true);
    expect(scoped.some(p => p.includes('/dest/baxian-cli-gh/references/extra.md'))).toBe(true);
    expect(scoped.some(p => p.includes('baxian-cli-forge'))).toBe(false);
    expect(scoped.some(p => p.includes('/dest/baxian-task-check/SKILL.md'))).toBe(true);

    written.length = 0;
    const bare = await registry.materialize(write, '/dest');
    expect(bare.some(p => p.includes('baxian-cli-'))).toBe(false);
  });

  it('keeps names/has on the core set so phase-skill checks ignore plugins', async () => {
    await seedPlugin('gh');
    expect(registry.names().sort()).toEqual(['baxian-signals', 'baxian-task-check']);
    expect(registry.has('baxian-cli-gh')).toBe(false);
    expect(registry.pluginSkillNames({ pluginTools: ['gh'] })).toEqual(['baxian-cli-gh']);
    expect(registry.pluginSkillNames()).toEqual([]);
  });

  it('hashes the scoped set: empty scope matches the core hash, plugin edits move only scoped hashes', async () => {
    const coreHash = registry.contentHash();
    expect(registry.contentHash({ pluginTools: [] })).toBe(coreHash);

    const skillsRoot = await seedPlugin('gh');
    expect(registry.contentHash()).toBe(coreHash);
    const scopedHash = registry.contentHash({ pluginTools: ['gh'] });
    expect(scopedHash).not.toBe(coreHash);

    await writeFile(join(skillsRoot, 'baxian-cli-gh', 'SKILL.md'), 'gh ops manual v2');
    await registry.scanPluginSkills('gh', skillsRoot);
    expect(registry.contentHash({ pluginTools: ['gh'] })).not.toBe(scopedHash);
    expect(registry.contentHash()).toBe(coreHash);
  });

  it('shares the loader candidate set: hidden and non-baxian dirs never enter the pool', async () => {
    const skillsRoot = join(base, 'plugin-hidden', 'skills');
    await seedSkillDir(skillsRoot, 'baxian-cli-hid', 'ops manual');
    await seedSkillDir(skillsRoot, '.internal', 'hidden payload');
    await seedSkillDir(skillsRoot, 'rogue-notes', 'unprefixed payload');
    await registry.scanPluginSkills('hid', skillsRoot);
    expect(registry.pluginSkillNames({ pluginTools: ['hid'] })).toEqual(['baxian-cli-hid']);
  });

  it('follows a symlinked plugin skill directory like the plugin loader does', async () => {
    const realDir = join(base, 'real-skill-src', 'baxian-cli-sym');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'SKILL.md'), 'symlinked ops manual');
    const skillsRoot = join(base, 'plugin-sym', 'skills');
    await mkdir(skillsRoot, { recursive: true });
    await symlink(realDir, join(skillsRoot, 'baxian-cli-sym'));
    await registry.scanPluginSkills('sym', skillsRoot);
    expect(registry.pluginSkillNames({ pluginTools: ['sym'] })).toEqual(['baxian-cli-sym']);
  });

  it('never follows links below the skill root: outside files stay out and cycles do not explode', async () => {
    const outside = join(base, 'outside-secret.txt');
    await writeFile(outside, 'secret');
    const skillsRoot = join(base, 'plugin-leak', 'skills');
    const skillDir = join(skillsRoot, 'baxian-cli-leak');
    await mkdir(join(skillDir, 'references'), { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), 'leak ops manual');
    await symlink(outside, join(skillDir, 'references', 'linked.txt'));
    await symlink(skillDir, join(skillDir, 'references', 'loop'));
    await registry.scanPluginSkills('leak', skillsRoot);
    const written: string[] = [];
    await registry.materialize(async (p) => { written.push(p); }, '/dest', { pluginTools: ['leak'] });
    expect(written).toContain('/dest/baxian-cli-leak/SKILL.md');
    expect(written.some(p => p.includes('linked.txt'))).toBe(false);
    expect(written.some(p => p.includes('loop'))).toBe(false);
  });

  it('propagates traversal errors instead of accepting a partial skill pool', async () => {
    if (process.getuid?.() === 0) return;
    const skillsRoot = join(base, 'plugin-unreadable', 'skills');
    const skillDir = join(skillsRoot, 'baxian-cli-bad');
    const lockedDir = join(skillDir, 'references');
    await mkdir(lockedDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), 'ops manual');
    await writeFile(join(lockedDir, 'note.md'), 'inner');
    await chmod(lockedDir, 0o000);
    try {
      await expect(registry.scanPluginSkills('bad', skillsRoot)).rejects.toThrow(/unreadable skill directory/);
      expect(registry.pluginSkillNames({ pluginTools: ['bad'] })).toEqual([]);
    } finally {
      await chmod(lockedDir, 0o755);
    }
  });

  it('rejects the whole plugin when any of its skills collides with a core skill', async () => {
    const skillsRoot = join(base, 'plugin-evil', 'skills');
    await seedSkillDir(skillsRoot, 'baxian-signals', 'hijacked signals');
    await seedSkillDir(skillsRoot, 'baxian-cli-evil', 'evil ops manual');
    await expect(registry.scanPluginSkills('evil', skillsRoot)).rejects.toThrow(/collides with a core skill/);
    expect(registry.pluginSkillNames({ pluginTools: ['evil'] })).toEqual([]);
    const contents = new Map<string, string>();
    await registry.materialize(async (path, content) => { contents.set(path, content.toString()); }, '/dest', { pluginTools: ['evil'] });
    expect(contents.get('/dest/baxian-signals/SKILL.md')).toBe('signals stub');
    expect([...contents.keys()].some(k => k.includes('baxian-cli-evil'))).toBe(false);
  });

  it('ignores an unknown tool in scope instead of failing the materialize pass', async () => {
    const written: string[] = [];
    const out = await registry.materialize(async (p) => { written.push(p); }, '/dest', { pluginTools: ['ghost'] });
    expect(out.every(p => !p.includes('baxian-cli-'))).toBe(true);
    expect(registry.contentHash({ pluginTools: ['ghost'] })).toBe(registry.contentHash());
  });
});

describe('AgentManager skill scope', () => {
  const CONFIG: BaxianConfig = {
    review: { rounds: 2 },
    server: DEFAULT_SERVER_CONFIG,
    host: [],
    project: [
      {
        id: 'proj-git',
        repo: 'git@github.com:owner/repo.git',
        merge: null,
        agent: [[{ id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo' }]],
      },
      {
        id: 'proj-server',
        repo: 'https://git.corp.example.com/g/p.git',
        merge: null,
        review: { mode: 'server' },
        agent: [[{ id: 'dev-2', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo2' }]],
      },
    ],
  };

  let stateDir = '';
  let manager: AgentManager;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'bx-scope-mgr-'));
    await initStateDir(stateDir);
    manager = new AgentManager({
      config: CONFIG,
      agentStore: new AgentStore(`${stateDir}/state/agents`),
      taskStore: new TaskStore(`${stateDir}/state/tasks`),
      lockManager: new LockManager(`${stateDir}/state`),
      eventBus: new EventBus(new EventLog(`${stateDir}/events`)),
      skillRegistry: registry,
    });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const scopeOf = (agentId: string) =>
    (manager as unknown as { agentSkillScope: (id: string) => { pluginTools: string[] } })
      .agentSkillScope(agentId);

  it('scopes a git-mode project agent to its resolved tool and leaves others empty', async () => {
    await seedPlugin('gh');
    vi.spyOn(manager, 'effectiveReviewMode').mockImplementation(
      (projectId: string) => (projectId === 'proj-git' ? 'git' : 'server'),
    );
    expect(scopeOf('dev-1')).toEqual({ pluginTools: ['gh'] });
    expect(scopeOf('dev-2')).toEqual({ pluginTools: [] });
    expect(scopeOf('ghost-agent')).toEqual({ pluginTools: [] });
  });

  it('server-mode agents resolve to the bare core scope', async () => {
    await seedPlugin('gh');
    vi.spyOn(manager, 'effectiveReviewMode').mockReturnValue('server');
    expect(scopeOf('dev-1')).toEqual({ pluginTools: [] });
    expect(scopeOf('dev-2')).toEqual({ pluginTools: [] });
  });

  it('git-mode agents pick up the plugin pool without any mode override (the default is git)', async () => {
    await seedPlugin('gh');
    expect(scopeOf('dev-1')).toEqual({ pluginTools: ['gh'] });
  });

  it('provisioning writes the scoped plugin skill and keeps it off legacy agents', async () => {
    await seedPlugin('gh');
    vi.spyOn(manager, 'effectiveReviewMode').mockImplementation(
      (projectId: string) => (projectId === 'proj-git' ? 'git' : 'server'),
    );
    const staged: string[] = [];
    const runner = {
      exec: vi.fn(async (cmd: string) => ({
        stdout: cmd.includes('BX_SKILLS_NON_GIT') ? 'BX_SKILLS_OK\n' : '',
        stderr: '',
        exitCode: 0,
      })),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (cmd: string) => {
        const m = /cat > '([^']+)'/.exec(cmd);
        if (m) staged.push(m[1]);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    const provision = (manager as unknown as {
      provisionRepoSkills: (r: unknown, a: unknown, w: string) => Promise<void>;
    }).provisionRepoSkills.bind(manager);

    const gitAgent = CONFIG.project[0].agent[0][0];
    await provision(runner, gitAgent, '/tmp/repo');
    expect(staged.some(p => p.includes('/tmp/repo/.claude/skills/baxian-cli-gh/SKILL.md'))).toBe(true);
    const cleanup = runner.exec.mock.calls.map(c => c[0] as string).find(c => c.includes('maxdepth 1'));
    expect(cleanup).toContain("! -name '\\''baxian-cli-gh'\\''");

    staged.length = 0;
    const serverAgent = CONFIG.project[1].agent[0][0];
    await provision(runner, serverAgent, '/tmp/repo2');
    expect(staged.some(p => p.includes('baxian-cli-gh'))).toBe(false);
  });
});

describe('SkillRegistry plugin scope over the real builtin plugin layout', () => {
  it('scans the plugin skills root exactly as index wires it and materializes baxian-cli-gh', async () => {
    const builtinRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../src/platform/plugins',
    );
    const { registry: plugins } = await PluginRegistry.load({ builtin: builtinRoot, user: join(base, 'no-user-plugins') });
    const gh = plugins.resolveTool('gh');
    expect(gh).toBeDefined();
    for (const plugin of plugins.all()) {
      await registry.scanPluginSkills(plugin.manifest.tool, join(plugin.pluginPath, 'skills'));
    }
    expect(registry.pluginSkillNames({ pluginTools: ['gh'] })).toContain('baxian-cli-gh');
    const written: string[] = [];
    await registry.materialize(async (p) => { written.push(p); }, '/dest', { pluginTools: ['gh'] });
    expect(written.some(p => p.includes('/dest/baxian-cli-gh/SKILL.md'))).toBe(true);
  });
});


describe('AgentManager.ensurePluginSkillPools', () => {
  const GIT_CFG: BaxianConfig = {
    review: { rounds: 2, mode: 'git' } as BaxianConfig['review'],
    server: DEFAULT_SERVER_CONFIG,
    host: [],
    project: [{
      id: 'proj-hot',
      repo: 'https://git.corp.example.com/g/p.git',
      merge: null,
      gitCli: { tool: 'hot' },
      agent: [],
    }],
  };

  let stateDir = '';

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'bx-pool-mgr-'));
    await initStateDir(stateDir);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const LEGAL_CFG: BaxianConfig = {
    review: { rounds: 2 },
    server: DEFAULT_SERVER_CONFIG,
    host: [],
    project: [],
  };

  function managerWithPlugin(pluginPath: string): AgentManager {
    return new AgentManager({
      config: LEGAL_CFG,
      agentStore: new AgentStore(`${stateDir}/state/agents`),
      taskStore: new TaskStore(`${stateDir}/state/tasks`),
      lockManager: new LockManager(`${stateDir}/state`),
      eventBus: new EventBus(new EventLog(`${stateDir}/events`)),
      skillRegistry: registry,
      pluginRegistry: {
        resolveTool: (tool: string) => (tool === 'hot'
          ? { manifest: { tool: 'hot', name: 'hot-plugin' }, pluginPath }
          : undefined),
      } as never,
    });
  }

  it('rescans a startup-skipped pool on first config reference and accepts a healthy plugin', async () => {
    const pluginPath = join(base, 'hot-plugin');
    await seedSkillDir(join(pluginPath, 'skills'), 'baxian-cli-hot', 'hot ops manual');
    const m = managerWithPlugin(pluginPath);
    expect(registry.pluginSkillNames({ pluginTools: ['hot'] })).toEqual([]);
    await m.ensurePluginSkillPools(GIT_CFG);
    expect(registry.pluginSkillNames({ pluginTools: ['hot'] })).toEqual(['baxian-cli-hot']);
  });

  it('rejects a config whose tool has no loaded plugin instead of persisting a restart-fatal state', async () => {
    const m = managerWithPlugin(join(base, 'never-scanned'));
    const missingTool: BaxianConfig = {
      ...GIT_CFG,
      project: [{ ...GIT_CFG.project[0], gitCli: { tool: 'ghost' } }],
    };
    await expect(m.ensurePluginSkillPools(missingTool)).rejects.toThrow(/no git-driver plugin provides tool 'ghost'/);
  });

  it('rejects the config when the referenced pool cannot be materialized', async () => {
    const pluginPath = join(base, 'hot-broken');
    const skillDir = join(pluginPath, 'skills', 'baxian-cli-hot');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), 'ok body');
    await writeFile(join(skillDir, 'bad.bin'), Buffer.from([0xff]));
    const m = managerWithPlugin(pluginPath);
    await expect(m.ensurePluginSkillPools(GIT_CFG)).rejects.toThrow(/invalid UTF-8/);
  });
});
