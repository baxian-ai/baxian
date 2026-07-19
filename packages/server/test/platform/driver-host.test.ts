import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginRegistry } from '../../src/platform/plugin-registry.js';
import { GitDriver, type DriverExecResult } from '../../src/platform/git-driver.js';
import { buildProjectDriver, makeDriverExec } from '../../src/platform/driver-host.js';
import type { CommandRunner, ExecOptions, ExecResult } from '../../src/agent/runner.js';
import type { ProjectConfig } from '../../src/shared/index.js';
import { MANIFEST, DRIVER } from './plugin-fixtures.js';

let base = '';
let registry: PluginRegistry;

async function writePlugin(root: string, tool: string): Promise<void> {
  const p = join(root, tool);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, 'baxian-plugin.json'), MANIFEST(tool));
  await writeFile(join(p, 'driver.json'), DRIVER);
  const skillDir = join(p, 'skills', `baxian-cli-${tool}`);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: baxian-cli-${tool}\ndescription: ops manual\n---\nbody`);
}

function project(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return { id: 'p1', repo: 'git@github.com:owner/repo.git', agent: [], ...over } as ProjectConfig;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bx-driver-host-'));
  const builtin = join(base, 'builtin');
  const user = join(base, 'user');
  await mkdir(builtin, { recursive: true });
  await mkdir(user, { recursive: true });
  await writePlugin(builtin, 'gh');
  await writePlugin(user, 'forge');
  registry = (await PluginRegistry.load({ builtin, user })).registry;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const NO_EXEC = () => Promise.reject(new Error('exec must not run in construction'));

describe('buildProjectDriver', () => {
  it('resolves the github zero-config path to the gh plugin', () => {
    const driver = buildProjectDriver(project(), registry, NO_EXEC);
    expect(driver).toBeInstanceOf(GitDriver);
  });

  it('uses the declared gitCli tool for non-github repos', () => {
    const driver = buildProjectDriver(
      project({ repo: 'https://git.corp.example.com/group/proj.git', gitCli: { tool: 'forge', binary: '/opt/bin/forge' } }),
      registry,
      NO_EXEC,
    );
    expect(driver).toBeInstanceOf(GitDriver);
  });

  it('returns undefined when the tool is unresolvable or the plugin is absent', () => {
    expect(buildProjectDriver(project({ repo: 'https://git.corp.example.com/g/p.git' }), registry, NO_EXEC))
      .toBeUndefined();
    expect(buildProjectDriver(project({ gitCli: { tool: 'unknown-tool' } }), registry, NO_EXEC))
      .toBeUndefined();
  });
});

describe('makeDriverExec', () => {
  function runnerWith(result: ExecResult): CommandRunner {
    return {
      exec: async (_command: string, _options?: ExecOptions) => result,
      writeFile: async () => undefined,
      execWithStdin: async () => result,
    };
  }

  it('passes the command through and resolves non-zero exit codes', async () => {
    const exec = makeDriverExec(runnerWith({ stdout: 'out', stderr: 'HTTP 404', exitCode: 1 }));
    const result: DriverExecResult = await exec('gh api x', { timeout: 1000, maxBuffer: 1024 });
    expect(result).toEqual({ stdout: 'out', stderr: 'HTTP 404', exitCode: 1 });
  });

  it('forwards timeout and maxBuffer to the runner', async () => {
    let seen: ExecOptions | undefined;
    const runner: CommandRunner = {
      exec: async (_command: string, options?: ExecOptions) => {
        seen = options;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      writeFile: async () => undefined,
      execWithStdin: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };
    await makeDriverExec(runner)('gh api y', { timeout: 1234, maxBuffer: 4096 });
    expect(seen).toEqual({ timeout: 1234, maxBuffer: 4096 });
  });
});
