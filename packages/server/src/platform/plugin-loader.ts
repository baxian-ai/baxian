import { spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { shellQuote } from '../agent/runner.js';
import { FS_READ_CONCURRENCY, mapWithConcurrency } from '../shared/concurrency.js';
import { isRecord } from '../shared/index.js';
import { assertInsideManagedDir } from '../state/managed-path.js';
import { BUILTIN_PLATFORMS, platformTakenError, registerPlatformProvider } from './driver-host.js';
import {
  DriverInputError,
  DriverOpError,
  PLATFORM_PLUGIN_API_VERSION,
  validateCommentBody,
  type PlatformPlugin,
  type PlatformPluginHost,
} from './types.js';

const PLATFORM_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const PROMPT_KEYS = ['common', 'publish', 'feedback', 'review'] as const;
const requirePlugin = createRequire(import.meta.url);

export interface InstalledPlugin {
  name: string;
  version: string;
}

export interface LoadedPlatformPlugin extends InstalledPlugin {
  platform: string;
}

export type PlatformPluginStatus = InstalledPlugin & (
  | { ok: true; platform: string }
  | { ok: false; error: string }
);

export type PluginFetcher = (spec: string, registry: string | undefined, destDir: string) => Promise<void>;

export function pluginsRoot(stateDir: string): string {
  return join(stateDir, 'plugins');
}

function pluginDir(stateDir: string, name: string): string {
  const root = pluginsRoot(stateDir);
  return assertInsideManagedDir(root, join(root, name));
}

interface PluginRecord {
  name: string;
  dir: string;
  pkg: Record<string, unknown> | null;
}

async function readInstalledPlugins(stateDir: string): Promise<PluginRecord[]> {
  const root = pluginsRoot(stateDir);
  const names: string[] = [];
  for (const entry of await readdirOrEmpty(root)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const sub of await readdirOrEmpty(join(root, entry.name))) {
        if (sub.isDirectory() && !sub.name.startsWith('.')) names.push(`${entry.name}/${sub.name}`);
      }
    } else {
      names.push(entry.name);
    }
  }
  names.sort();
  return mapWithConcurrency(names, FS_READ_CONCURRENCY, async name => {
    const dir = pluginDir(stateDir, name);
    return { name, dir, pkg: await readPackageJson(dir) };
  });
}

function versionOf(pkg: Record<string, unknown> | null): string {
  return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
}

export async function listInstalledPlugins(stateDir: string): Promise<InstalledPlugin[]> {
  return (await readInstalledPlugins(stateDir)).map(({ name, pkg }) => ({ name, version: versionOf(pkg) }));
}

export async function loadPlatformPlugins(stateDir: string): Promise<LoadedPlatformPlugin[]> {
  const loaded: LoadedPlatformPlugin[] = [];
  for (const { name, dir, pkg } of await readInstalledPlugins(stateDir)) {
    const plugin = loadPluginModule(dir, name, pkg);
    try {
      registerPlatformProvider(plugin.provider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`platform plugin ${name}: ${message}`, { cause: err });
    }
    loaded.push({ name, version: versionOf(pkg), platform: plugin.provider.platform });
  }
  return loaded;
}

export async function platformPluginStatuses(stateDir: string): Promise<PlatformPluginStatus[]> {
  const seenPlatforms = new Set<string>(BUILTIN_PLATFORMS);
  const statuses: PlatformPluginStatus[] = [];
  for (const { name, dir, pkg } of await readInstalledPlugins(stateDir)) {
    const entry = { name, version: versionOf(pkg) };
    try {
      const plugin = loadPluginModule(dir, name, pkg);
      const platform = plugin.provider.platform;
      if (seenPlatforms.has(platform)) {
        throw platformTakenError(platform);
      }
      seenPlatforms.add(platform);
      statuses.push({ ...entry, ok: true, platform });
    } catch (err) {
      statuses.push({ ...entry, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return statuses;
}

export async function installPlatformPlugin(
  stateDir: string,
  spec: string,
  registry: string | undefined,
  fetch: PluginFetcher = defaultPluginFetcher,
): Promise<LoadedPlatformPlugin> {
  const name = packageNameOfSpec(spec);
  const root = pluginsRoot(stateDir);
  await mkdir(root, { recursive: true });
  const staging = assertInsideManagedDir(root, await mkdtemp(join(root, '.staging-')));
  try {
    const fetched = join(staging, 'package');
    await mkdir(fetched);
    await fetch(spec, registry, fetched);

    const pkg = await readPackageJson(fetched);
    if (pkg === null || typeof pkg.name !== 'string') {
      throw new Error(`fetched package for ${name} has no valid package.json`);
    }
    if (pkg.name !== name) {
      throw new Error(`registry returned package '${pkg.name}' for requested '${name}'`);
    }
    const { platform } = loadPluginModule(fetched, name, pkg).provider;

    const statuses = await platformPluginStatuses(stateDir);
    if (BUILTIN_PLATFORMS.includes(platform)
      || statuses.some(status => status.ok && status.name !== name && status.platform === platform)) {
      throw platformTakenError(platform);
    }
    // A silent platform rename flips the identity key prefix and strands bound tasks; a broken install stays overwritable for repair.
    const current = statuses.find(status => status.name === name);
    if (current?.ok === true && current.platform !== platform) {
      throw new Error(
        `plugin ${name} currently provides platform '${current.platform}'; refusing an upgrade `
        + `that changes it to '${platform}' — uninstall the plugin first if the rename is intentional`,
      );
    }

    const dir = pluginDir(stateDir, name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await rename(fetched, dir);
    return { name, version: versionOf(pkg), platform };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function uninstallPlatformPlugin(stateDir: string, name: string): Promise<void> {
  const installed = await listInstalledPlugins(stateDir);
  if (!installed.some(entry => entry.name === name)) {
    throw new Error(`plugin ${name} is not installed`);
  }
  await rm(pluginDir(stateDir, name), { recursive: true, force: true });
}

const NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const REGISTRY_RANGE_PATTERN = /^[A-Za-z0-9^~<>=.*| +_-]+$/;

export function packageNameOfSpec(spec: string): string {
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const range = at > 0 ? spec.slice(at + 1) : null;
  if (!NAME_PATTERN.test(name) || (range !== null && !REGISTRY_RANGE_PATTERN.test(range))) {
    throw new Error(
      `plugin spec must be an npm package name, optionally followed by @<version|range|dist-tag> (got: ${spec})`,
    );
  }
  return name;
}

// require() on a directory never honors "exports", so the contract demands an explicit "main".
function pluginEntryPath(dir: string, name: string, pkg: Record<string, unknown> | null): string {
  if (pkg === null) {
    throw new Error(`platform plugin ${name} has no readable package.json`);
  }
  const main = typeof pkg.main === 'string' && pkg.main !== '' ? pkg.main : null;
  if (main === null) {
    throw new Error(`platform plugin ${name} must declare a "main" entry file in package.json (exports-only packages are not supported)`);
  }
  // Checked on the raw value: the staging leaf is literally "package", so "../package/x" joins back inside there yet escapes after the rename.
  const entry = normalize(main);
  if (isAbsolute(entry) || entry === '..' || entry.startsWith(`..${sep}`)) {
    throw new Error(`platform plugin ${name} "main" must resolve inside the package directory (got: ${main})`);
  }
  return join(dir, entry);
}

function loadPluginModule(dir: string, name: string, pkg: Record<string, unknown> | null): PlatformPlugin {
  const entry = pluginEntryPath(dir, name, pkg);
  let mod: unknown;
  try {
    mod = requirePlugin(entry) as unknown;
  } catch (err) {
    throw new Error(`platform plugin ${name} failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
  const factory = isRecord(mod) && 'default' in mod ? mod.default : mod;
  if (typeof factory !== 'function') {
    throw new Error(`platform plugin ${name} must export a factory function as its default export`);
  }
  let plugin: unknown;
  try {
    plugin = factory(PLUGIN_HOST) as unknown;
  } catch (err) {
    throw new Error(`platform plugin ${name} factory threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  assertValidPlugin(name, plugin);
  return plugin;
}

const PLUGIN_HOST: PlatformPluginHost = { DriverOpError, DriverInputError, validateCommentBody, shellQuote };

function assertValidPlugin(name: string, plugin: unknown): asserts plugin is PlatformPlugin {
  if (!isRecord(plugin)) {
    throw new Error(`platform plugin ${name} factory must return a plugin object`);
  }
  if (plugin.apiVersion !== PLATFORM_PLUGIN_API_VERSION) {
    throw new Error(
      `platform plugin ${name} targets apiVersion ${String(plugin.apiVersion)}, `
      + `this baxian supports ${PLATFORM_PLUGIN_API_VERSION}`,
    );
  }
  const provider = plugin.provider;
  if (!isRecord(provider)) {
    throw new Error(`platform plugin ${name} must provide a provider object`);
  }
  if (typeof provider.platform !== 'string' || !PLATFORM_NAME_PATTERN.test(provider.platform)) {
    throw new Error(
      `platform plugin ${name} provider.platform must match ${String(PLATFORM_NAME_PATTERN)} `
      + `(got: ${String(provider.platform)})`,
    );
  }
  if (typeof provider.normalizeRepoUrl !== 'function' || typeof provider.createDriver !== 'function') {
    throw new Error(`platform plugin ${name} provider must implement normalizeRepoUrl and createDriver`);
  }
  const prompts = provider.prompts;
  if (!isRecord(prompts) || PROMPT_KEYS.some(key => typeof prompts[key] !== 'string' || prompts[key].trim() === '')) {
    throw new Error(`platform plugin ${name} provider.prompts must contain non-empty ${PROMPT_KEYS.join('/')} strings`);
  }
}

async function readdirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readPackageJson(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Remote npm pack runs no lifecycle scripts; auth and proxies come from the user's npm config.
const defaultPluginFetcher: PluginFetcher = async (spec, registry, destDir) => {
  runTool('npm', [
    'pack', spec, '--pack-destination', destDir,
    ...(registry === undefined ? [] : [`--registry=${registry}`]),
  ], destDir);
  const tarballs = (await readdir(destDir)).filter(file => file.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one packed tarball in ${destDir}, found ${tarballs.length}`);
  }
  const tarball = assertInsideManagedDir(destDir, join(destDir, tarballs[0]));
  runTool('tar', ['-xzf', tarball, '-C', destDir, '--strip-components', '1'], destDir);
  await rm(tarball, { force: true });
};

function runTool(file: string, args: string[], cwd: string): void {
  const result = spawnSync(file, args, { cwd, encoding: 'utf-8' });
  if (result.error) throw new Error(`failed to run ${file}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${file} ${args[0]} failed (exit ${result.status}): ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim()}`,
    );
  }
}
