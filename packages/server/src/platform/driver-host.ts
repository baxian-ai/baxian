import type { CommandRunner } from '../agent/runner.js';
import type { ProjectConfig } from '../shared/types.js';
import {
  GITHUB_AGENT_PROMPTS,
  buildGitHubRunContext,
  GitHubDriver,
} from './github-driver.js';
import type { DriverExec, PlatformDriver, PlatformPromptContext } from './types.js';

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
  return new GitHubDriver(buildGitHubRunContext(repo), exec);
}

export function buildProjectPromptContext(project: ProjectConfig): PlatformPromptContext {
  return {
    repo: buildGitHubRunContext(project.repo).repoPath,
    prompts: GITHUB_AGENT_PROMPTS,
  };
}
