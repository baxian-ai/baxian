import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  probeTmux,
  runPreflight,
  type PreflightResult,
} from '../../src/agent/preflight.js';
import {
  LocalRunner,
  type CommandRunner,
  type ExecOptions,
  type ExecResult,
} from '../../src/agent/runner.js';
import type { AgentConfig } from '../../src/shared/index.js';

const REPO = 'https://github.com/owner/repo.git';
const SSH_REPO = 'git@github.com:owner/repo.git';
const OK: ExecResult = { stdout: '', stderr: '', exitCode: 0 };

class TestRunner implements CommandRunner {
  readonly calls: Array<{ command: string; options?: ExecOptions }> = [];

  constructor(private readonly respond: (command: string) => ExecResult | Promise<ExecResult>) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ command, options });
    return this.respond(command);
  }

  writeFile(): Promise<void> {
    return Promise.resolve();
  }

  execWithStdin(command: string, _stdin: Buffer, options?: ExecOptions): Promise<ExecResult> {
    return this.exec(command, options);
  }
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'dev-1',
    runtime: 'claude-code',
    role: 'dev',
    mode: 'local',
    workdir: '/work/repo',
    ...overrides,
  };
}

interface RunnerOptions {
  pushPermitted?: boolean;
  authExit?: number;
  authStderr?: string;
  projectExit?: number;
  projectStderr?: string;
  workdir?: string;
  pushUrls?: string[];
  lsRemoteExit?: number;
}

function healthyRunner(options: RunnerOptions = {}): TestRunner {
  return new TestRunner(command => {
    if (command === 'command -v claude') return { ...OK, stdout: '/usr/bin/claude\n' };
    if (command === 'command -v codex') return { ...OK, stdout: '/usr/bin/codex\n' };
    if (command === 'command -v tmux') return { ...OK, stdout: '/usr/bin/tmux\n' };
    if (command.includes('git remote get-url --push --all origin')) {
      return { ...OK, stdout: (options.pushUrls ?? [REPO]).join('\n') + '\n' };
    }
    if (command.includes('git remote get-url origin')) {
      return { ...OK, stdout: `${REPO}\n` };
    }
    if (command.includes('git rev-parse --show-toplevel')) return OK;
    if (command.startsWith('cd ~ && pwd -P')) {
      return { ...OK, stdout: `${options.workdir ?? '/home/agent'}\n` };
    }
    if (command.startsWith('mkdir -p ')) return OK;
    if (command.startsWith('test -d ')) return { ...OK, exitCode: 1 };
    if (command.includes('git ls-remote')) {
      return { ...OK, exitCode: options.lsRemoteExit ?? 0, stderr: 'git access failed' };
    }
    if (command.includes("'gh' 'api' 'user'")) {
      return { ...OK, exitCode: options.authExit ?? 0, stderr: options.authStderr ?? 'auth failed' };
    }
    if (command.includes("'gh' 'api' 'repos/owner/repo'")) {
      if ((options.projectExit ?? 0) !== 0) {
        return { ...OK, exitCode: options.projectExit!, stderr: options.projectStderr ?? 'repo denied' };
      }
      return {
        ...OK,
        stdout: JSON.stringify({
          default_branch: 'main',
          node_id: 'R_repo',
          permissions: { push: options.pushPermitted ?? true },
        }),
      };
    }
    throw new Error(`unexpected command: ${command}`);
  });
}

function byStep(results: PreflightResult[], step: string): PreflightResult | undefined {
  return results.find(result => result.step === step);
}

afterEach(() => vi.restoreAllMocks());

describe('probeTmux', () => {
  it('reports the resolved binary', async () => {
    const result = await probeTmux(new TestRunner(() => ({ ...OK, stdout: '/opt/bin/tmux\n' })), 'proj');
    expect(result).toEqual({ step: 'tmux', ok: true, message: 'tmux found at /opt/bin/tmux' });
  });

  it('returns an actionable failure when tmux is absent', async () => {
    const result = await probeTmux(new TestRunner(() => ({ ...OK, exitCode: 127 })), 'proj');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('baxian check proj --fix');
  });
});

describe('runPreflight', () => {
  it('checks the agent CLI, tmux, configured Git channels, and GitHub permissions', async () => {
    const runner = healthyRunner({ pushUrls: [REPO, SSH_REPO] });

    const results = await runPreflight(runner, agent(), REPO, undefined, 'proj', {
      requireGitPush: true,
    });

    for (const step of ['cli', 'tmux', 'workdir', 'git', 'github-auth', 'platform-repo', 'platform-push']) {
      expect.soft(byStep(results, step), step).toMatchObject({ ok: true });
    }
    expect(runner.calls.some(call => call.command.includes('git remote get-url --push --all origin'))).toBe(true);
    expect(runner.calls.filter(call => call.command.includes('git ls-remote'))).toHaveLength(2);
  });

  it('requires push permission for Dev but not QA', async () => {
    const dev = await runPreflight(healthyRunner({ pushPermitted: false }), agent(), REPO);
    const qa = await runPreflight(
      healthyRunner({ pushPermitted: false }),
      agent({ id: 'qa-1', role: 'qa', runtime: 'codex' }),
      REPO,
    );

    expect(byStep(dev, 'platform-push')).toMatchObject({ ok: false });
    expect(byStep(qa, 'platform-push')).toMatchObject({ ok: true });
  });

  it('stops GitHub repository probes after authentication fails', async () => {
    const runner = healthyRunner({ authExit: 1 });
    const results = await runPreflight(runner, agent(), REPO);

    expect(byStep(results, 'github-auth')).toMatchObject({ ok: false });
    expect(byStep(results, 'platform-repo')).toBeUndefined();
    expect(runner.calls.some(call => call.command.includes('repos/owner/repo'))).toBe(false);
  });

  it('returns a safe failed check when the platform preflight is rate limited', async () => {
    const runner = healthyRunner({ authExit: 1, authStderr: 'secondary rate limit: secret-detail' });
    const results = await runPreflight(runner, agent(), REPO);

    expect(byStep(results, 'driver-preflight')).toEqual({
      step: 'driver-preflight',
      ok: false,
      message: 'op github-auth failed (exit 1, class RATE_LIMIT)',
    });
    expect(results.some(result => result.message.includes('secret-detail'))).toBe(false);
    expect(byStep(results, 'platform-repo')).toBeUndefined();
  });

  it('reports repository denial without returning raw stderr', async () => {
    const secret = 'token=do-not-return';
    const results = await runPreflight(
      healthyRunner({ projectExit: 1, projectStderr: secret }),
      agent(),
      REPO,
    );

    const result = byStep(results, 'platform-repo');
    expect(result).toMatchObject({ ok: false });
    expect(result?.message).not.toContain(secret);
  });

  it.each([REPO, SSH_REPO])('auto mode probes the configured clone URL directly: %s', async repo => {
    const runner = healthyRunner();
    const results = await runPreflight(runner, agent({ workdir: undefined }), repo);

    expect(byStep(results, 'workdir')?.message).toContain('git clone');
    const lsRemote = runner.calls.find(call => call.command.includes('git ls-remote'))?.command;
    expect(lsRemote).toContain(repo);
    expect(runner.calls.some(call => call.command.includes('gh config get'))).toBe(false);
  });

  it('fails when a fixed Workdir publisher has no push origin', async () => {
    const runner = healthyRunner({ pushUrls: [] });
    const results = await runPreflight(runner, agent(), REPO, undefined, 'proj', {
      requireGitPush: true,
    });

    expect(byStep(results, 'git')).toMatchObject({ ok: false });
    expect(byStep(results, 'git')?.message).toContain('no push origin');
  });

  it('fails the Git check when the configured URL is unreachable', async () => {
    const results = await runPreflight(
      healthyRunner({ lsRemoteExit: 128 }),
      agent({ workdir: undefined }),
      REPO,
    );
    expect(byStep(results, 'git')).toMatchObject({ ok: false });
    expect(byStep(results, 'git')?.message).toContain(REPO);
    expect(byStep(results, 'git')?.message).toContain('gh auth setup-git');
  });

  it('reports SSH credential remediation without suggesting the GitHub HTTPS helper', async () => {
    const results = await runPreflight(
      healthyRunner({ lsRemoteExit: 128 }),
      agent({ workdir: undefined }),
      SSH_REPO,
    );
    expect(byStep(results, 'git')).toMatchObject({ ok: false });
    expect(byStep(results, 'git')?.message).toContain('SSH key');
    expect(byStep(results, 'git')?.message).not.toContain('gh auth setup-git');
  });

  it('returns immediately for a remote agent whose host config is missing', async () => {
    const results = await runPreflight(
      healthyRunner(),
      agent({ mode: 'remote', host: 'missing' }),
      REPO,
    );
    expect(results).toEqual([{ step: 'ssh', ok: false, message: 'Remote agent missing host config' }]);
  });

  it('stops after an unreachable remote SSH host', async () => {
    vi.spyOn(LocalRunner.prototype, 'exec').mockResolvedValue({
      stdout: '', stderr: 'unreachable', exitCode: 255,
    });
    const results = await runPreflight(
      healthyRunner(),
      agent({ mode: 'remote', host: 'box' }),
      REPO,
      { hostname: 'box.example.com', user: 'agent' },
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ step: 'ssh', ok: false });
  });

  it('keeps probing independent checks when the agent CLI is absent', async () => {
    const base = healthyRunner();
    const runner = new TestRunner(command => command === 'command -v claude'
      ? { ...OK, exitCode: 127 }
      : base.exec(command));

    const results = await runPreflight(runner, agent(), REPO);

    expect(byStep(results, 'cli')).toMatchObject({ ok: false });
    expect(byStep(results, 'tmux')).toMatchObject({ ok: true });
    expect(byStep(results, 'platform-repo')).toMatchObject({ ok: true });
  });
});
