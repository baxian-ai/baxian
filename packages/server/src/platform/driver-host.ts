import type { CommandRunner } from '../agent/runner.js';
import type { ProjectConfig } from '../shared/types.js';
import { resolveProjectTool } from '../config/validator.js';
import { buildDriverRunContext, GitDriver, type DriverExec } from './git-driver.js';
import type { PluginRegistry } from './plugin-registry.js';

export function makeDriverExec(runner: CommandRunner): DriverExec {
  return (command, opts) => runner.exec(command, { timeout: opts.timeout, maxBuffer: opts.maxBuffer });
}

export function buildProjectDriver(
  project: ProjectConfig,
  registry: PluginRegistry,
  exec: DriverExec,
): GitDriver | undefined {
  const tool = resolveProjectTool(project);
  if (tool === undefined) return undefined;
  const plugin = registry.resolveTool(tool);
  if (plugin === undefined) return undefined;
  const binary = project.gitCli?.binary ?? tool;
  return new GitDriver(plugin, buildDriverRunContext(project.repo, binary), exec);
}
