import { describe, expect, it } from 'vitest';
import { GitHubDriver } from '../../src/platform/github-driver.js';
import { buildProjectDriver, makeDriverExec } from '../../src/platform/driver-host.js';
import type { DriverExecResult } from '../../src/platform/types.js';
import type { CommandRunner, ExecOptions, ExecResult } from '../../src/agent/runner.js';
import type { ProjectConfig } from '../../src/shared/index.js';

const project: ProjectConfig = {
  id: 'p1',
  repo: 'git@github.com:owner/repo.git',
  merge: null,
  agent: [],
};
const NO_EXEC = () => Promise.reject(new Error('exec must not run during construction'));

describe('buildProjectDriver', () => {
  it('builds the currently supported GitHub driver', () => {
    const first = buildProjectDriver(project, NO_EXEC);
    const second = buildProjectDriver(project, NO_EXEC);
    expect(first).toBeInstanceOf(GitHubDriver);
    expect(second).toBeInstanceOf(GitHubDriver);
    expect(second).not.toBe(first);
  });

  it('rejects repositories that the current platform resolver does not support', () => {
    expect(() => buildProjectDriver({ ...project, repo: 'https://gitlab.com/o/r.git' }, NO_EXEC))
      .toThrow(/GitHub driver requires/);
  });
});

describe('makeDriverExec', () => {
  function runnerWith(value: ExecResult): CommandRunner {
    return {
      exec: async () => value,
      writeFile: async () => undefined,
      execWithStdin: async () => value,
    };
  }

  it('passes through non-zero results and execution limits', async () => {
    let seen: ExecOptions | undefined;
    const runner: CommandRunner = {
      ...runnerWith({ stdout: 'out', stderr: 'HTTP 404', exitCode: 1 }),
      exec: async (_command, options) => {
        seen = options;
        return { stdout: 'out', stderr: 'HTTP 404', exitCode: 1 };
      },
    };
    const value: DriverExecResult = await makeDriverExec(runner)('gh api x', {
      timeout: 1234,
      maxBuffer: 4096,
    });
    expect(value).toEqual({ stdout: 'out', stderr: 'HTTP 404', exitCode: 1 });
    expect(seen).toEqual({ timeout: 1234, maxBuffer: 4096 });
  });

  it('uses execWithStdin whenever stdin is present, including an empty buffer', async () => {
    let seen: { command: string; stdin: Buffer; options?: ExecOptions } | undefined;
    const runner: CommandRunner = {
      exec: async () => { throw new Error('plain exec must not receive stdin-backed operations'); },
      writeFile: async () => undefined,
      execWithStdin: async (command, stdin, options) => {
        seen = { command, stdin, options };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    await makeDriverExec(runner)('gh api comment', {
      timeout: 1234,
      maxBuffer: 4096,
      stdin: Buffer.alloc(0),
    });
    expect(seen).toEqual({
      command: 'gh api comment',
      stdin: Buffer.alloc(0),
      options: { timeout: 1234, maxBuffer: 4096 },
    });
  });
});
