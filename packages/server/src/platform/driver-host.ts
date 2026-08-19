import type { CommandRunner } from '../agent/runner.js';
import { isRecord } from '../shared/index.js';
import type { ProjectConfig } from '../shared/types.js';
import { githubProvider } from './github-driver.js';
import { validateRows, type NormalizedRow } from './row-schema.js';
import {
  COMMENT_SOURCE_CLASSES,
  DriverOpError,
  SOURCE_KEY_PATTERN,
  type DriverExec,
  type PlatformDriver,
  type PlatformPromptContext,
  type PlatformProvider,
  type PreflightStep,
} from './types.js';

const builtinProviders: readonly PlatformProvider[] = [githubProvider];
const pluginProviders: PlatformProvider[] = [];

export const BUILTIN_PLATFORMS: readonly string[] = builtinProviders.map(p => p.platform);

export interface ResolvedRepo {
  provider: PlatformProvider;
  slug: string;
  identityKey: string;
}

export class AmbiguousRepoClaimError extends Error {
  constructor(platforms: readonly string[]) {
    super(`repository URL is claimed by multiple platform plugins (${platforms.join(', ')})`);
    this.name = 'AmbiguousRepoClaimError';
  }
}

export class InvalidRepoClaimError extends Error {
  constructor(platform: string) {
    super(`platform '${platform}' returned an invalid repo slug`);
    this.name = 'InvalidRepoClaimError';
  }
}

export function platformTakenError(platform: string): Error {
  return new Error(`platform '${platform}' is already registered`);
}

export function registerPlatformProvider(provider: PlatformProvider): void {
  if (BUILTIN_PLATFORMS.includes(provider.platform)
    || pluginProviders.some(p => p.platform === provider.platform)) {
    throw platformTakenError(provider.platform);
  }
  pluginProviders.push(provider);
}

export function resetPlatformProviders(): void {
  pluginProviders.length = 0;
}

// Built-ins win outright; plugin order is sorted directory names, so overlapping plugin claims are an error, not a tiebreak.
export function resolveRepo(repo: string): ResolvedRepo | null {
  const url = repo.trim();
  for (const provider of builtinProviders) {
    const claim = claimOf(provider, url);
    if (claim !== null) return claim;
  }
  const claims = pluginProviders
    .map(provider => claimOf(provider, url))
    .filter((claim): claim is ResolvedRepo => claim !== null);
  if (claims.length > 1) {
    throw new AmbiguousRepoClaimError(claims.map(claim => claim.provider.platform));
  }
  return claims[0] ?? null;
}

function claimOf(provider: PlatformProvider, url: string): ResolvedRepo | null {
  const slug = provider.normalizeRepoUrl(url);
  if (slug === null || slug === undefined) return null;
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new InvalidRepoClaimError(provider.platform);
  }
  return { provider, slug, identityKey: `${provider.platform}/${slug}` };
}

export function repoIdentityKey(repo: string): string {
  return resolveRepo(repo)?.identityKey ?? repo.trim();
}

export function makeDriverExec(runner: CommandRunner): DriverExec {
  return (command, opts) => opts.stdin === undefined
    ? runner.exec(command, { timeout: opts.timeout, maxBuffer: opts.maxBuffer })
    : runner.execWithStdin(
        command,
        opts.stdin,
        { timeout: opts.timeout, maxBuffer: opts.maxBuffer },
      );
}

export function buildProjectDriver(
  project: ProjectConfig,
  exec: DriverExec,
): PlatformDriver {
  return buildRepoDriver(project.repo, exec);
}

export function buildRepoDriver(repo: string, exec: DriverExec): PlatformDriver {
  const resolved = requireResolvedRepo(repo);
  try {
    return withRowValidation(resolved.provider.createDriver(resolved.slug, exec));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`platform '${resolved.provider.platform}': ${message}`, { cause: err });
  }
}

function toRowObjects(opName: string, value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : [value];
  if (rows.some(row => row === null || typeof row !== 'object')) {
    throw new DriverOpError(`op ${opName} returned a non-object row`, { opName });
  }
  return rows as Record<string, unknown>[];
}

function singleRow(opName: string, rows: NormalizedRow[]): NormalizedRow {
  if (rows.length !== 1) {
    throw new DriverOpError(`op ${opName} must yield exactly one row (got ${rows.length})`, { opName });
  }
  return rows[0]!;
}

const SOURCE_CATEGORIES: ReadonlySet<string> = new Set(COMMENT_SOURCE_CLASSES);

// Cursors, ack markers, and the timeline bucket by source key, and ack trust rules switch on category — bad values corrupt them silently.
function assertCommentSources(sources: unknown): void {
  if (!Array.isArray(sources)) {
    throw new Error('commentSources must be an array');
  }
  const seen = new Set<string>();
  for (const [i, source] of (sources as unknown[]).entries()) {
    // RegExp.test would coerce a missing key to the string 'undefined', which matches the pattern.
    if (!isRecord(source) || typeof source.key !== 'string') {
      throw new Error(`comment source at index ${i} must be an object with a string key`);
    }
    if (!SOURCE_KEY_PATTERN.test(source.key)) {
      throw new Error(`comment source key '${source.key}' must match ${String(SOURCE_KEY_PATTERN)}`);
    }
    if (seen.has(source.key)) {
      throw new Error(`comment source key '${source.key}' is declared more than once`);
    }
    seen.add(source.key);
    if (typeof source.category !== 'string' || !SOURCE_CATEGORIES.has(source.category)) {
      throw new Error(
        `comment source '${source.key}' has invalid category '${String(source.category)}' `
        + `(expected top-level, threaded, or reviews)`,
      );
    }
  }
  // collectValidAcks never accepts acks from 'reviews' sources, so without one of the others feedback deadlocks.
  if (!(sources as { category?: unknown }[]).some(s => s.category === 'top-level' || s.category === 'threaded')) {
    throw new Error('commentSources must include at least one top-level or threaded source (acks in reviews sources are ignored)');
  }
}

function assertPreflightSteps(value: unknown): PreflightStep[] {
  if (!Array.isArray(value)) {
    throw new Error(`runPreflightSteps must return an array (got ${value === null ? 'null' : typeof value})`);
  }
  for (const [i, item] of (value as unknown[]).entries()) {
    if (!isRecord(item)) throw new Error(`runPreflightSteps[${i}] must be an object`);
    if (typeof item.step !== 'string') throw new Error(`runPreflightSteps[${i}].step must be a string`);
    // A truthy non-boolean (e.g. 'false') would silently pass the gate; consumers branch on !ok.
    if (typeof item.ok !== 'boolean') throw new Error(`runPreflightSteps[${i}].ok must be a boolean`);
    if (typeof item.message !== 'string') throw new Error(`runPreflightSteps[${i}].message must be a string`);
    if (item.errorClass !== undefined && typeof item.errorClass !== 'string') {
      throw new Error(`runPreflightSteps[${i}].errorClass must be a string when present`);
    }
  }
  return value as PreflightStep[];
}

function withRowValidation(driver: PlatformDriver): PlatformDriver {
  // Feeds verdict/cursor time fences: NaN confirms passes early (comparisons all false), Infinity never confirms.
  if (!Number.isFinite(driver.visibilityLagMs) || driver.visibilityLagMs < 0) {
    throw new Error(
      `visibilityLagMs must be a finite number >= 0 (got: ${String(driver.visibilityLagMs)})`,
    );
  }
  assertCommentSources(driver.commentSources);
  const rows = (opName: string, value: unknown, opts?: Parameters<typeof validateRows>[2]) =>
    validateRows(
      opName,
      toRowObjects(opts?.sourceKey === undefined ? opName : `${opName}[${opts.sourceKey}]`, value),
      opts,
    );
  const one = (opName: string, value: unknown) => singleRow(opName, rows(opName, value));
  // Stop predicates read versionTimeOf() on whatever page the plugin hands them; raw rows could stall or truncate the scan.
  const guardStop = (
    opName: string,
    stop: ((pageRows: NormalizedRow[], page: number) => boolean) | undefined,
    opts?: Parameters<typeof validateRows>[2],
  ) => stop === undefined
    ? undefined
    : (pageRows: NormalizedRow[], page: number) => stop(rows(opName, pageRows, opts), page);
  return {
    visibilityLagMs: driver.visibilityLagMs,
    commentSources: driver.commentSources,
    runPreflightSteps: async () => assertPreflightSteps(await driver.runPreflightSteps()),
    projectView: async () => one('projectView', await driver.projectView()),
    prView: async (prNumber) => one('prView', await driver.prView(prNumber)),
    branchView: async (remoteProjectId, branch) =>
      one('branchView', await driver.branchView(remoteProjectId, branch)),
    listPrs: async (shouldStop) =>
      rows('listPrs', await driver.listPrs(guardStop('listPrs', shouldStop))),
    listComments: async (source, prNumber, projectPage, shouldStop) => {
      const opts = {
        sourceKey: source.key,
        ...(source.category === 'threaded'
          ? { requireMapped: { discussionId: 'thread roots use null or their own id' } }
          : {}),
      };
      const validatePage = (pageRows: unknown) => rows('listComments', pageRows, opts);
      const collected: NormalizedRow[] = [];
      let pageError: unknown;
      let pagedInline = false;
      const result = await driver.listComments(
        source,
        prNumber,
        pageRows => {
          pagedInline = true;
          try {
            const projected = projectPage === undefined
              ? validatePage(pageRows)
              : projectPage(validatePage(pageRows));
            collected.push(...projected);
            return projected;
          } catch (err) {
            pageError ??= err;
            throw err;
          }
        },
        guardStop('listComments', shouldStop, opts),
      );
      if (pageError !== undefined) throw pageError;
      // A paging plugin's aggregate may ignore the vetted rows, and re-validating projected rows would blank every comment (Symbol and body are gone).
      return pagedInline ? collected : validatePage(result);
    },
    postComment: (prNumber, body) => driver.postComment(prNumber, body),
    mergePr: (prNumber, expectedHeadSha) => driver.mergePr(prNumber, expectedHeadSha),
    closePr: (prNumber) => driver.closePr(prNumber),
    deleteBranch: (remoteProjectId, branch, expectedHeadSha) =>
      driver.deleteBranch(remoteProjectId, branch, expectedHeadSha),
  };
}

export function buildProjectPromptContext(project: ProjectConfig): PlatformPromptContext {
  const resolved = requireResolvedRepo(project.repo);
  return { repo: resolved.slug, prompts: resolved.provider.prompts };
}

function requireResolvedRepo(repo: string): ResolvedRepo {
  const resolved = resolveRepo(repo);
  if (resolved === null) {
    throw new Error(`no installed platform recognizes repository URL: ${repo}`);
  }
  return resolved;
}
