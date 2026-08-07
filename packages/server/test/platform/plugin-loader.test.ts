import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPlatformProviders, resolveRepo } from '../../src/platform/driver-host.js';
import {
  installPlatformPlugin,
  listInstalledPlugins,
  loadPlatformPlugins,
  packageNameOfSpec,
  platformPluginStatuses,
  pluginsRoot,
  uninstallPlatformPlugin,
  type PluginFetcher,
} from '../../src/platform/plugin-loader.js';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'baxian-plugin-'));
});

afterEach(async () => {
  resetPlatformProviders();
  await rm(stateDir, { recursive: true, force: true });
});

const VALID_FACTORY = (platform: string): string => `
module.exports = function createPlugin(host) {
  if (typeof host.shellQuote !== 'function' || typeof host.DriverOpError !== 'function') {
    throw new Error('host utilities missing');
  }
  return {
    apiVersion: 1,
    provider: {
      platform: '${platform}',
      normalizeRepoUrl: (url) => url.startsWith('https://${platform}/')
        ? url.slice('https://${platform}/'.length).replace(/\\.git$/, '')
        : null,
      createDriver: () => ({ visibilityLagMs: 1 }),
      prompts: { common: 'c', publish: 'p', feedback: 'f', review: 'r' },
    },
  };
};
`;

async function writePackageInto(
  dir: string,
  name: string,
  source: string,
  opts: { version?: string; esm?: boolean } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const entry = opts.esm ? 'index.mjs' : 'index.cjs';
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name,
    version: opts.version ?? '1.0.0',
    main: entry,
  }));
  await writeFile(join(dir, entry), source);
}

async function installFixture(
  name: string,
  source: string,
  opts: { version?: string; esm?: boolean } = {},
): Promise<void> {
  await writePackageInto(join(pluginsRoot(stateDir), name), name, source, opts);
}

function fetcherWriting(
  name: string,
  source: string,
  opts: { version?: string; esm?: boolean } = {},
): { fetch: PluginFetcher; calls: Array<{ spec: string; registry: string | undefined; destDir: string }> } {
  const calls: Array<{ spec: string; registry: string | undefined; destDir: string }> = [];
  const fetch: PluginFetcher = async (spec, registry, destDir) => {
    calls.push({ spec, registry, destDir });
    await writePackageInto(destDir, name, source, opts);
  };
  return { fetch, calls };
}

async function writeExportsOnlyPackage(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'corp-exports-only',
    version: '1.0.0',
    exports: './dist/index.mjs',
  }));
}

async function stagingLeftovers(): Promise<string[]> {
  const entries = await readdir(pluginsRoot(stateDir)).catch(() => [] as string[]);
  return entries.filter(entry => entry.startsWith('.staging-'));
}

describe('listInstalledPlugins', () => {
  it('returns an empty list when the plugins directory does not exist', async () => {
    await expect(listInstalledPlugins(stateDir)).resolves.toEqual([]);
  });

  it('lists scoped and unscoped plugin directories with their versions, sorted', async () => {
    await installFixture('corp-b', VALID_FACTORY('b.corp.example'), { version: '2.0.0' });
    await installFixture('@corp/a-driver', VALID_FACTORY('a.corp.example'), { version: '1.2.3' });
    await expect(listInstalledPlugins(stateDir)).resolves.toEqual([
      { name: '@corp/a-driver', version: '1.2.3' },
      { name: 'corp-b', version: '2.0.0' },
    ]);
  });
});

describe('loadPlatformPlugins', () => {
  it('loads and registers a CommonJS plugin so its repositories resolve', async () => {
    await installFixture('@corp/git-driver', VALID_FACTORY('git.corp.example'));
    await expect(loadPlatformPlugins(stateDir)).resolves.toEqual([
      { name: '@corp/git-driver', version: '1.0.0', platform: 'git.corp.example' },
    ]);
    expect(resolveRepo('https://git.corp.example/group/sub/repo.git')).toMatchObject({
      slug: 'group/sub/repo',
      identityKey: 'git.corp.example/group/sub/repo',
    });
    expect(resolveRepo('https://github.com/o/r.git')).toMatchObject({ identityKey: 'github.com/o/r' });
  });

  it('loads an ES module plugin through its default export', async () => {
    await installFixture(
      'corp-esm-driver',
      VALID_FACTORY('esm.corp.example').replace('module.exports =', 'export default'),
      { esm: true },
    );
    await expect(loadPlatformPlugins(stateDir)).resolves.toEqual([
      { name: 'corp-esm-driver', version: '1.0.0', platform: 'esm.corp.example' },
    ]);
    expect(resolveRepo('https://esm.corp.example/a/b')).not.toBeNull();
  });

  it('fails fast with the plugin name when a plugin is broken', async () => {
    await installFixture('corp-broken', 'module.exports = 42;');
    await expect(loadPlatformPlugins(stateDir)).rejects.toThrow(/corp-broken must export a factory function/);
  });
});

describe('platformPluginStatuses', () => {
  it('reports load state per plugin without aborting on the first failure', async () => {
    await installFixture('corp-a-ok', VALID_FACTORY('ok.corp.example'));
    await installFixture('corp-b-old-api', VALID_FACTORY('old.corp.example').replace('apiVersion: 1', 'apiVersion: 99'));
    await installFixture('corp-c-github-clash', VALID_FACTORY('github.com'));

    const statuses = await platformPluginStatuses(stateDir);
    expect(statuses).toEqual([
      expect.objectContaining({ name: 'corp-a-ok', ok: true, platform: 'ok.corp.example' }),
      expect.objectContaining({ name: 'corp-b-old-api', ok: false, error: expect.stringMatching(/apiVersion 99.*supports 1/) }),
      expect.objectContaining({ name: 'corp-c-github-clash', ok: false, error: expect.stringMatching(/already registered/) }),
    ]);
  });

  it('rejects invalid provider shapes with a reason', async () => {
    await installFixture(
      'corp-bad-prompts',
      VALID_FACTORY('bad.corp.example').replace("feedback: 'f', ", ''),
    );
    const statuses = await platformPluginStatuses(stateDir);
    expect(statuses[0]).toMatchObject({ ok: false, error: expect.stringMatching(/prompts/) });
  });

  it('rejects exports-only packages that declare no "main" entry', async () => {
    await writeExportsOnlyPackage(join(pluginsRoot(stateDir), 'corp-exports-only'));
    const statuses = await platformPluginStatuses(stateDir);
    expect(statuses[0]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/must declare a "main" entry file/),
    });
  });

  it('reports an installed plugin whose "main" escapes the package directory as broken', async () => {
    const dir = join(pluginsRoot(stateDir), 'corp-esc');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'corp-esc',
      version: '1.0.0',
      main: '../corp-esc/index.cjs',
    }));
    await writeFile(join(dir, 'index.cjs'), VALID_FACTORY('esc.corp.example'));
    const statuses = await platformPluginStatuses(stateDir);
    expect(statuses[0]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/"main" must resolve inside the package directory/),
    });
  });
});

describe('installPlatformPlugin', () => {
  it('fetches, validates in staging, places the plugin, and cleans the staging dir', async () => {
    const { fetch, calls } = fetcherWriting('@corp/git-driver', VALID_FACTORY('git.corp.example'), { version: '1.2.3' });

    await expect(installPlatformPlugin(stateDir, '@corp/git-driver@^1.0.0', 'https://npm.corp.example', fetch))
      .resolves.toEqual({ name: '@corp/git-driver', version: '1.2.3', platform: 'git.corp.example' });

    expect(calls).toEqual([{
      spec: '@corp/git-driver@^1.0.0',
      registry: 'https://npm.corp.example',
      destDir: expect.stringContaining(join(pluginsRoot(stateDir), '.staging-')),
    }]);
    await expect(listInstalledPlugins(stateDir)).resolves.toEqual([
      { name: '@corp/git-driver', version: '1.2.3' },
    ]);
    await expect(stagingLeftovers()).resolves.toEqual([]);
  });

  it('leaves the installed version untouched when a fetched upgrade fails validation', async () => {
    await installFixture('corp-up', VALID_FACTORY('up.corp.example'), { version: '1.0.0' });
    const { fetch } = fetcherWriting('corp-up', 'module.exports = 42;', { version: '2.0.0' });

    await expect(installPlatformPlugin(stateDir, 'corp-up@2.0.0', undefined, fetch))
      .rejects.toThrow(/corp-up must export a factory function/);

    await expect(listInstalledPlugins(stateDir)).resolves.toEqual([{ name: 'corp-up', version: '1.0.0' }]);
    const source = await readFile(join(pluginsRoot(stateDir), 'corp-up', 'index.cjs'), 'utf-8');
    expect(source).toContain('up.corp.example');
    await expect(stagingLeftovers()).resolves.toEqual([]);
  });

  it('refuses a same-package upgrade that changes the platform, keeping the old version', async () => {
    await installFixture('corp-up', VALID_FACTORY('old.example'), { version: '1.0.0' });
    const { fetch } = fetcherWriting('corp-up', VALID_FACTORY('new.example'), { version: '2.0.0' });

    await expect(installPlatformPlugin(stateDir, 'corp-up@2.0.0', undefined, fetch))
      .rejects.toThrow(/currently provides platform 'old\.example'.*uninstall the plugin first/);

    const statuses = await platformPluginStatuses(stateDir);
    expect(statuses[0]).toMatchObject({ name: 'corp-up', version: '1.0.0', ok: true, platform: 'old.example' });
    await expect(stagingLeftovers()).resolves.toEqual([]);
  });

  it('lets a reinstall repair a broken plugin even when its platform differs', async () => {
    await installFixture('corp-broken', 'module.exports = 42;', { version: '1.0.0' });
    const { fetch } = fetcherWriting('corp-broken', VALID_FACTORY('fixed.example'), { version: '1.0.1' });

    await expect(installPlatformPlugin(stateDir, 'corp-broken', undefined, fetch))
      .resolves.toMatchObject({ name: 'corp-broken', version: '1.0.1', platform: 'fixed.example' });
  });

  it('replaces the previous version when the fetched upgrade is valid', async () => {
    await installFixture('corp-up', VALID_FACTORY('up.corp.example'), { version: '1.0.0' });
    const { fetch } = fetcherWriting('corp-up', VALID_FACTORY('up.corp.example'), { version: '2.0.0' });

    await expect(installPlatformPlugin(stateDir, 'corp-up@2.0.0', undefined, fetch))
      .resolves.toEqual({ name: 'corp-up', version: '2.0.0', platform: 'up.corp.example' });
    await expect(listInstalledPlugins(stateDir)).resolves.toEqual([{ name: 'corp-up', version: '2.0.0' }]);
  });

  it('rejects a package whose name differs from the requested plugin', async () => {
    const { fetch } = fetcherWriting('other-name', VALID_FACTORY('x.corp.example'));
    await expect(installPlatformPlugin(stateDir, 'corp-wanted', undefined, fetch))
      .rejects.toThrow(/registry returned package 'other-name' for requested 'corp-wanted'/);
    expect(existsSync(join(pluginsRoot(stateDir), 'corp-wanted'))).toBe(false);
  });

  it('rejects a fetched package without a "main" entry before placing it', async () => {
    const fetch: PluginFetcher = (_spec, _registry, destDir) => writeExportsOnlyPackage(destDir);
    await expect(installPlatformPlugin(stateDir, 'corp-exports-only', undefined, fetch))
      .rejects.toThrow(/must declare a "main" entry file/);
    expect(existsSync(join(pluginsRoot(stateDir), 'corp-exports-only'))).toBe(false);
  });

  it('rejects a "main" that escapes the package directory before placing it', async () => {
    await installFixture('corp-esc', VALID_FACTORY('esc.corp.example'), { version: '1.0.0' });
    for (const main of ['../package/index.cjs', '/outside/index.cjs']) {
      const fetch: PluginFetcher = async (_spec, _registry, destDir) => {
        await mkdir(destDir, { recursive: true });
        await writeFile(join(destDir, 'package.json'), JSON.stringify({
          name: 'corp-esc',
          version: '2.0.0',
          main,
        }));
        await writeFile(join(destDir, 'index.cjs'), VALID_FACTORY('esc.corp.example'));
      };
      await expect(installPlatformPlugin(stateDir, 'corp-esc@2.0.0', undefined, fetch))
        .rejects.toThrow(/"main" must resolve inside the package directory/);
    }
    await expect(listInstalledPlugins(stateDir)).resolves.toEqual([{ name: 'corp-esc', version: '1.0.0' }]);
    await expect(stagingLeftovers()).resolves.toEqual([]);
  });

  it('rejects a plugin whose platform is already claimed by another installed plugin', async () => {
    await installFixture('corp-first', VALID_FACTORY('shared.corp.example'));
    const { fetch } = fetcherWriting('corp-second', VALID_FACTORY('shared.corp.example'));

    await expect(installPlatformPlugin(stateDir, 'corp-second', undefined, fetch))
      .rejects.toThrow(/platform 'shared\.corp\.example' is already registered/);
    expect(existsSync(join(pluginsRoot(stateDir), 'corp-second'))).toBe(false);
  });

  it('rejects non-registry package specs in full, not just the name prefix', async () => {
    let fetched = false;
    const fetch: PluginFetcher = async () => {
      fetched = true;
    };
    for (const bad of [
      'https://evil.example/x.tgz',
      'corp-driver@https://evil.example/x.tgz',
      'corp-driver@git+https://evil.example/x.git',
      'corp-driver@file:../somewhere',
      'alias@npm:real-pkg@1.0.0',
      'corp-driver@',
    ]) {
      await expect(installPlatformPlugin(stateDir, bad, undefined, fetch), bad)
        .rejects.toThrow(/npm package name/);
    }
    expect(fetched).toBe(false);
    expect(packageNameOfSpec('@scope/name@1.2.3')).toBe('@scope/name');
    expect(packageNameOfSpec('name')).toBe('name');
    expect(packageNameOfSpec('name@latest')).toBe('name');
    expect(packageNameOfSpec('name@^1.2.3-beta.1+build')).toBe('name');
    expect(packageNameOfSpec('name@>=1.2 <2 || 3.x')).toBe('name');
  });
});

describe('uninstallPlatformPlugin', () => {
  it('refuses to uninstall a plugin that is not installed', async () => {
    await expect(uninstallPlatformPlugin(stateDir, 'corp-none')).rejects.toThrow(/not installed/);
  });

  it('removes the plugin directory, including scoped names', async () => {
    await installFixture('@corp/a-driver', VALID_FACTORY('a.corp.example'));
    await uninstallPlatformPlugin(stateDir, '@corp/a-driver');
    expect(existsSync(join(pluginsRoot(stateDir), '@corp', 'a-driver'))).toBe(false);
    await expect(listInstalledPlugins(stateDir)).resolves.toEqual([]);
  });
});
