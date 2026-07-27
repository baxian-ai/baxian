import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { probeTmux, runPreflight, type AgentGitPreflight } from '../../src/agent/preflight.js';
import { LocalRunner } from '../../src/agent/runner.js';
import * as runnerModule from '../../src/agent/runner.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { DriverOpError } from '../../src/platform/git-driver.js';
import type { AgentConfig } from '../../src/shared/index.js';

const OK_PATH: ExecResult = { stdout: '/usr/local/bin/x', stderr: '', exitCode: 0 };
const OK_TRUE: ExecResult = { stdout: 'true\n', stderr: '', exitCode: 0 };
const OK_EMPTY: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const FAIL: ExecResult = { stdout: '', stderr: 'not found', exitCode: 1 };

function mockRunner(responses: Record<string, ExecResult>): CommandRunner {
  return {
    exec: vi.fn(async (cmd: string) => {
      for (const [pattern, result] of Object.entries(responses)) {
        if (cmd.includes(pattern)) return result;
      }
      if (cmd.includes('cd ~ && pwd -P')) return { stdout: '/home/owner\n', stderr: '', exitCode: 0 };
      if (cmd.includes('git remote get-url --push --all origin')) {
        return { stdout: 'https://github.com/user/repo.git\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('git remote get-url origin')) {
        return { stdout: 'https://github.com/user/repo.git\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-parse --show-toplevel')) return OK_TRUE;
      if (cmd.startsWith('command -v')) return OK_PATH;
      if (cmd.includes("'--version'")) return { stdout: 'gh version 2.40.0', stderr: '', exitCode: 0 };
      return OK_EMPTY;
    }),
  };
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/code', ...overrides };
}

const execCmds = (runner: CommandRunner): string[] =>
  (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);

beforeEach(() => { runnerModule.__resetMuxDirReadyForTests(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('runPreflight', () => {
  it('passes all checks when everything is available', async () => {
    const runner = mockRunner({});
    const results = await runPreflight(runner, makeAgent(), 'user/repo');
    expect(results.every(r => r.ok)).toBe(true);
    expect(results.map(r => r.step).sort()).toEqual(['cli', 'git', 'tmux', 'workdir']);
  });

  it('detects missing CLI', async () => {
    const runner = mockRunner({ 'command -v claude': FAIL });
    const results = await runPreflight(runner, makeAgent(), 'user/repo');
    const cli = results.find(r => r.step === 'cli');
    expect(cli?.ok).toBe(false);
    expect(cli?.message).toContain('install');
  });

  it('detects missing tmux', async () => {
    const runner = mockRunner({ 'command -v tmux': FAIL });
    const results = await runPreflight(runner, makeAgent(), 'user/repo');
    expect(results.find(r => r.step === 'tmux')?.ok).toBe(false);
  });

  it('points a missing-tmux failure at "baxian check <id> --fix" when the project id is known', async () => {
    const runner = mockRunner({ 'command -v tmux': FAIL });
    const results = await runPreflight(runner, makeAgent(), 'user/repo', undefined, 'proj-9');
    const tmux = results.find(r => r.step === 'tmux');
    expect(tmux?.ok).toBe(false);
    expect(tmux?.message).toContain('baxian check proj-9 --fix');
  });

  it('falls back to a <project> placeholder in the missing-tmux hint without a project id', async () => {
    const runner = mockRunner({ 'command -v tmux': FAIL });
    const results = await runPreflight(runner, makeAgent(), 'user/repo');
    expect(results.find(r => r.step === 'tmux')?.message).toContain('baxian check <project> --fix');
  });

  it('probes via POSIX command -v, never which, so a which-less minimal host still passes', async () => {
    const noWhich: ExecResult = { stdout: '', stderr: 'sh: which: not found', exitCode: 127 };
    const runner = mockRunner({ 'which ': noWhich });
    const results = await runPreflight(runner, makeAgent(), 'user/repo', undefined, 'proj-1');
    expect(results.find(r => r.step === 'tmux')?.ok).toBe(true);
    expect(results.find(r => r.step === 'cli')?.ok).toBe(true);
    expect(execCmds(runner).some(c => c.startsWith('which '))).toBe(false);
  });

  it('probeTmux (the --fix reprobe) matches installTmux verification on a which-less host', async () => {
    const noWhich: ExecResult = { stdout: '', stderr: 'sh: which: not found', exitCode: 127 };
    const runner = mockRunner({
      'which ': noWhich,
      'command -v tmux': { stdout: '/usr/bin/tmux\n', stderr: '', exitCode: 0 },
    });
    const result = await probeTmux(runner, 'proj-1');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('/usr/bin/tmux');
  });

  it('no longer probes openssl on remote agents (injection uses tmux load-buffer, not openssl)', async () => {
    vi.spyOn(LocalRunner.prototype, 'exec').mockResolvedValue({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    const remoteAgent = makeAgent({
      mode: 'remote',
      host: { hostname: 'remote.example.com', user: 'agent' },
    });
    // Even with openssl unavailable, a remote agent must not get a preflight failure for it.
    const runner = mockRunner({ 'command -v openssl': FAIL });
    const results = await runPreflight(runner, remoteAgent, 'user/repo', { hostname: 'remote.example.com', user: 'agent' });
    expect(results.find(r => r.step === 'openssl')).toBeUndefined();
    expect(results.find(r => r.step === 'tmux')?.ok).toBe(true);
  });

  it('uses a fresh (noMux) ssh connection for the remote reachability check so a stale master cannot mask invalid creds', async () => {
    const execSpy = vi.spyOn(LocalRunner.prototype, 'exec').mockResolvedValue({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    await runPreflight(
      mockRunner({}),
      makeAgent({ mode: 'remote', host: { hostname: 'box', user: 'rock' } }),
      'user/repo',
      { hostname: 'box', user: 'rock' },
    );
    const sshCall = execSpy.mock.calls.find(c => String(c[0]).includes('echo ok'));
    expect(sshCall?.[0]).toContain('ControlPath=none');
    expect(sshCall?.[0]).not.toContain('cm-%C');
    execSpy.mockRestore();
  });

  it('ensures the ssh mux dir before the first remote ssh check (preflight runs before SshRunner on fresh process)', async () => {
    const ensureSpy = vi.spyOn(runnerModule, 'ensureMuxDir').mockResolvedValue();
    vi.spyOn(LocalRunner.prototype, 'exec').mockResolvedValue({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    const remoteAgent = makeAgent({
      mode: 'remote',
      host: { hostname: 'remote.example.com', user: 'agent' },
    });
    await runPreflight(mockRunner({}), remoteAgent, 'user/repo', { hostname: 'remote.example.com', user: 'agent' });
    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it('detects bad workdir', async () => {
    const runner = mockRunner({ 'rev-parse --show-toplevel': FAIL });
    const results = await runPreflight(runner, makeAgent(), 'user/repo');
    expect(results.find(r => r.step === 'workdir')?.ok).toBe(false);
  });

  it('checks for codex CLI when runtime is codex', async () => {
    const runner = mockRunner({});
    await runPreflight(runner, makeAgent({ runtime: 'codex' }), 'user/repo');
    expect(execCmds(runner).some(c => c.includes('command -v codex'))).toBe(true);
  });

  it('detects git access failure', async () => {
    const runner = mockRunner({ 'git ls-remote': FAIL });
    const results = await runPreflight(runner, makeAgent(), 'user/repo');
    expect(results.find(r => r.step === 'git')?.ok).toBe(false);
  });

  it('detects gh auth failure', async () => {
    const runner = mockRunner({ 'gh auth status': FAIL });
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    expect(results.find(r => r.step === 'gh')).toMatchObject({
      ok: false,
      message: 'Run "gh auth login" or set GITHUB_TOKEN',
    });
  });

  it('bounds the gh auth probe and reports a timeout as an unknown outcome', async () => {
    const fallback = mockRunner({});
    const fallbackExec = fallback.exec.bind(fallback);
    fallback.exec = vi.fn(async (cmd: string, options?: Parameters<CommandRunner['exec']>[1]) => {
      if (cmd === 'gh auth status') throw new Error('Command timed out after 30000ms');
      return fallbackExec(cmd, options);
    });
    const results = await runPreflight(fallback, makeAutoAgent(), 'user/repo');
    expect(results.find(r => r.step === 'gh')).toMatchObject({ ok: false });
    expect(results.find(r => r.step === 'gh')?.message).toContain('outcome is unknown');
    const call = (fallback.exec as ReturnType<typeof vi.fn>).mock.calls.find(c => c[0] === 'gh auth status');
    expect(call?.[1]).toMatchObject({ timeout: 30_000 });
  });

  it('does not prescribe relogin when gh auth status fails with an indeterminate transport result', async () => {
    const runner = mockRunner({
      'gh auth status': { stdout: '', stderr: 'connection reset by peer', exitCode: 255 },
    });
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const gh = results.find(r => r.step === 'gh');
    expect(gh).toMatchObject({ ok: false });
    expect(gh?.message).toContain('outcome is unknown');
    expect(gh?.message).not.toContain('gh auth login');
  });

  it('detects repo access failure via gh api', async () => {
    const runner = mockRunner({ 'gh api repos/': FAIL });
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    expect(results.find(r => r.step === 'gh-repo')?.ok).toBe(false);
  });

  it('binary probes match the runtime mode of each binary: claude/codex use login-interactive (tmux pane); tmux + other ops stay on default login (-lc)', async () => {
    vi.spyOn(LocalRunner.prototype, 'exec').mockResolvedValue({ stdout: 'ok\n', stderr: '', exitCode: 0 });

    const calls: Array<{ cmd: string; opts?: { remoteShell?: string } }> = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string, opts?: { remoteShell?: string }) => {
        calls.push({ cmd, opts });
        if (cmd.includes('rev-parse --show-toplevel')) return OK_TRUE;
        if (cmd.startsWith('command -v')) return OK_PATH;
        return OK_EMPTY;
      }),
    };
    await runPreflight(runner, makeAgent({ mode: 'remote', host: { hostname: 'box', user: 'rock' } }), 'user/repo', { hostname: 'box', user: 'rock' });

    const cliWhich = calls.find(c => c.cmd === 'command -v claude');
    expect(cliWhich?.opts?.remoteShell).toBe('login-interactive');

    const tmuxWhich = calls.find(c => c.cmd === 'command -v tmux');
    expect(tmuxWhich?.opts?.remoteShell).toBeUndefined();

    const otherCalls = calls.filter(c => /^(git |gh |mkdir |test |cd )/.test(c.cmd));
    expect(otherCalls.length).toBeGreaterThan(0);
    for (const c of otherCalls) {
      expect(c.opts?.remoteShell).toBeUndefined();
    }
  });

  it('probe with exitCode 0 but empty stdout is treated as failure (avoids misleading "X found at " messages)', async () => {
    vi.spyOn(LocalRunner.prototype, 'exec').mockResolvedValue({ stdout: 'ok\n', stderr: '', exitCode: 0 });

    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === 'command -v tmux') return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.startsWith('command -v')) return OK_PATH;
        return OK_EMPTY;
      }),
    };

    const results = await runPreflight(
      runner,
      makeAgent({ mode: 'remote', host: { hostname: 'box', user: 'rock' } }),
      'user/repo',
      { hostname: 'box', user: 'rock' },
    );

    const tmux = results.find(r => r.step === 'tmux');
    expect(tmux?.ok).toBe(false);
    expect(tmux?.message).not.toContain('found at');
  });

  it('cli/tmux probe rejection (timeout / abort / spawn error) is converted into a per-step failure result, not propagated as a thrown error that would 500 the /projects/:id/checks API', async () => {
    vi.spyOn(LocalRunner.prototype, 'exec').mockResolvedValue({ stdout: 'ok\n', stderr: '', exitCode: 0 });

    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === 'command -v claude') {
          throw new Error('spawn ssh ENOENT');
        }
        if (cmd === 'command -v tmux') {
          throw new Error('Command timed out after 5000ms');
        }
        if (cmd.startsWith('command -v')) return OK_PATH;
        return OK_EMPTY;
      }),
    };

    const results = await runPreflight(
      runner,
      makeAgent({ mode: 'remote', host: { hostname: 'box', user: 'rock' } }),
      'user/repo',
      { hostname: 'box', user: 'rock' },
    );

    const cli = results.find(r => r.step === 'cli');
    expect(cli?.ok).toBe(false);
    expect(cli?.message).toMatch(/probe failed/i);
    expect(cli?.message).toMatch(/spawn ssh ENOENT/);

    const tmux = results.find(r => r.step === 'tmux');
    expect(tmux?.ok).toBe(false);
    expect(tmux?.message).toMatch(/timed out/i);
  });
});

function makeAutoAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { id: 'dev-auto', runtime: 'claude-code', role: 'dev', mode: 'local', ...overrides };
}

describe('runPreflight — auto mode', () => {
  it('runs mkdir -p for the per-agent clone parent and checks it is writable', async () => {
    const runner = mockRunner({});
    await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const calls = execCmds(runner);
    expect(calls.some(c => c.includes('mkdir -p') && c.includes('.baxian/agents/dev-auto'))).toBe(true);
    expect(calls.some(c => c.includes('test -w') && c.includes('.baxian/agents/dev-auto'))).toBe(true);
  });

  it('uses the agent id rather than the project slug for the clone path', async () => {
    const runner = mockRunner({});
    await runPreflight(runner, makeAutoAgent(), 'Owner/Repo');
    const calls = execCmds(runner);
    expect(calls.some(c => c.includes("test -d '/home/owner/.baxian/agents/dev-auto/repo'"))).toBe(true);
    expect(calls.some(c => /test -d .*Owner\/Repo/.test(c))).toBe(false);
  });

  it('uses HTTPS ls-remote when gh git_protocol is https', async () => {
    const runner = mockRunner({
      'gh config get git_protocol': { stdout: 'https\n', stderr: '', exitCode: 0 },
    });
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const calls = execCmds(runner);
    expect(calls.some(c => c.includes('git ls-remote') && c.includes('https://github.com/user/repo.git'))).toBe(true);
    expect(results.find(r => r.step === 'git')?.ok).toBe(true);
  });

  it('uses SSH ls-remote when gh git_protocol is ssh', async () => {
    const runner = mockRunner({
      'gh config get git_protocol': { stdout: 'ssh\n', stderr: '', exitCode: 0 },
    });
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const calls = execCmds(runner);
    expect(calls.some(c => c.includes('git ls-remote') && c.includes('git@github.com:user/repo.git'))).toBe(true);
    expect(results.find(r => r.step === 'git')?.ok).toBe(true);
  });

  it('HTTPS ls-remote failure includes setup-git hint', async () => {
    const runner = mockRunner({
      'gh config get git_protocol': { stdout: 'https\n', stderr: '', exitCode: 0 },
      'git ls-remote': FAIL,
    });
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const git = results.find(r => r.step === 'git');
    expect(git?.ok).toBe(false);
    expect(git?.message).toMatch(/gh auth setup-git/i);
  });

  it('reports workdir failure when existing repo dir is not a git repo', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('cd ~ && pwd -P')) return { stdout: '/home/owner\n', stderr: '', exitCode: 0 };
      if (cmd.includes('git remote get-url --push --all origin')) {
        return { stdout: 'https://github.com/user/repo.git\n', stderr: '', exitCode: 0 };
      }
        if (cmd.includes('mkdir -p') && cmd.includes('.baxian/agents/dev-auto')) return OK_EMPTY;
        if (cmd === `test -d '/home/owner/.baxian/agents/dev-auto/repo'`) return OK_EMPTY;
        if (cmd.includes('rev-parse --show-toplevel')) return FAIL;
        if (cmd.startsWith('command -v')) return OK_PATH;
        return OK_EMPTY;
      }),
    };
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const wd = results.find(r => r.step === 'workdir');
    expect(wd?.ok).toBe(false);
    expect(wd?.message).toMatch(/not an independent ordinary Git clone/i);
  });

  it('passes workdir when existing repo dir is a valid git repo', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('cd ~ && pwd -P')) return { stdout: '/home/owner\n', stderr: '', exitCode: 0 };
      if (cmd.includes('git remote get-url --push --all origin')) {
        return { stdout: 'https://github.com/user/repo.git\n', stderr: '', exitCode: 0 };
      }
        if (cmd.includes('mkdir -p')) return OK_EMPTY;
        if (cmd === `test -d '/home/owner/.baxian/agents/dev-auto/repo'`) return OK_EMPTY;
        if (cmd.startsWith('command -v')) return OK_PATH;
        return OK_EMPTY;
      }),
    };
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const wd = results.find(r => r.step === 'workdir');
    expect(wd?.ok).toBe(true);
    expect(execCmds(runner).some(c => c.includes('objects/info/alternates'))).toBe(true);
  });

  it('rejects a bare repository at the managed clone path', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('cd ~ && pwd -P')) return { stdout: '/home/owner\n', stderr: '', exitCode: 0 };
      if (cmd.includes('git remote get-url --push --all origin')) {
        return { stdout: 'https://github.com/user/repo.git\n', stderr: '', exitCode: 0 };
      }
        if (cmd.includes('mkdir -p')) return OK_EMPTY;
        if (cmd === `test -d '/home/owner/.baxian/agents/dev-auto/repo'`) return OK_EMPTY;
        if (cmd.includes('rev-parse --is-bare-repository')) return FAIL;
        if (cmd.startsWith('command -v')) return OK_PATH;
        return OK_EMPTY;
      }),
    };
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const wd = results.find(r => r.step === 'workdir');
    expect(wd?.ok).toBe(false);
    expect(wd?.message).toMatch(/independent ordinary/i);
  });

  it('passes workdir when nothing exists yet (clone will create it)', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('cd ~ && pwd -P')) return { stdout: '/home/owner\n', stderr: '', exitCode: 0 };
      if (cmd.includes('git remote get-url --push --all origin')) {
        return { stdout: 'https://github.com/user/repo.git\n', stderr: '', exitCode: 0 };
      }
        if (cmd.includes('mkdir -p')) return OK_EMPTY;
        if (cmd === `test -d '/home/owner/.baxian/agents/dev-auto/repo'`) return FAIL;
        if (cmd.startsWith('command -v')) return OK_PATH;
        return OK_EMPTY;
      }),
    };
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const wd = results.find(r => r.step === 'workdir');
    expect(wd?.ok).toBe(true);
  });
});

describe('runPreflight — non-GitHub (generic git) repos', () => {
  const GL = 'https://gitlab.example.com/group/proj.git';

  it('manual mode: skips gh checks and probes fetch access through origin', async () => {
    const runner = mockRunner({ 'git remote get-url origin': { stdout: `${GL}\n`, stderr: '', exitCode: 0 } });
    const results = await runPreflight(runner, makeAgent(), GL);
    expect(results.find(r => r.step === 'gh')).toBeUndefined();
    expect(results.find(r => r.step === 'gh-repo')).toBeUndefined();
    const cmds = execCmds(runner);
    expect(cmds.some(c => c.includes('gh auth') || c.includes('gh api'))).toBe(false);
    expect(cmds.some(c => c.includes('git ls-remote') && c.includes(GL))).toBe(true);
    expect(results.find(r => r.step === 'git')?.ok).toBe(true);
  });

  it('auto mode: uses the per-agent clone path and git ls-remote, never gh', async () => {
    const runner = mockRunner({});
    await runPreflight(runner, makeAgent({ workdir: undefined }), GL);
    const cmds = execCmds(runner);
    expect(cmds.some(c => c.includes('.baxian/agents/dev-1/repo'))).toBe(true);
    expect(cmds.some(c => c.includes('gh config get git_protocol'))).toBe(false);
    expect(cmds.some(c => c.includes('gh auth') || c.includes('gh api'))).toBe(false);
    expect(cmds.some(c => c.includes('git ls-remote') && c.includes(GL))).toBe(true);
  });

  it('auto mode: shell-quotes a malicious repo URL instead of executing it', async () => {
    const runner = mockRunner({});
    const evil = 'https://gitlab.example.com;touch pwned/group/proj.git';
    await expect(runPreflight(runner, makeAgent({ workdir: undefined }), evil)).resolves.toBeDefined();
    const cmds = execCmds(runner);
    const lsRemote = cmds.find(c => c.includes('git ls-remote'));
    expect(lsRemote).toContain("'https://gitlab.example.com;touch pwned/group/proj.git'");
  });

  it('auto mode: redacts embedded credentials from a failed ls-remote message', async () => {
    const runner = mockRunner({ 'git ls-remote': FAIL });
    const url = 'https://oauth2:TOKEN@gitlab.example.com/group/proj.git';
    const results = await runPreflight(runner, makeAgent({ workdir: undefined }), url);
    const git = results.find(r => r.step === 'git');
    expect(git?.ok).toBe(false);
    expect(git?.message).not.toContain('TOKEN');
    expect(git?.message).toContain('gitlab.example.com');
  });

  it('auto mode: trims a whitespace-padded repo URL before ls-remote', async () => {
    const runner = mockRunner({});
    await runPreflight(runner, makeAgent({ workdir: undefined }), '  https://gitlab.example.com/group/proj.git  ');
    const cmds = execCmds(runner);
    expect(cmds.some(c => c.includes("git ls-remote 'https://gitlab.example.com/group/proj.git'"))).toBe(true);
    expect(cmds.some(c => c.includes('  https'))).toBe(false);
  });

  it('a manual github server project skips gh when no PR workflow needs it', async () => {
    const runner = mockRunner({});
    const results = await runPreflight(runner, makeAgent(), 'user/repo');
    expect(results.find(r => r.step === 'gh')).toBeUndefined();
    expect(results.find(r => r.step === 'gh-repo')).toBeUndefined();
    expect(execCmds(runner).some(c => c.includes('gh auth') || c.includes('gh api'))).toBe(false);
  });

  it('a fixed Workdir with no publish workflow still requires origin for fetch and checkout', async () => {
    const runner = mockRunner({
      'git remote get-url origin': { stdout: '', stderr: 'No such remote', exitCode: 2 },
    });

    const results = await runPreflight(
      runner, makeAgent(), 'user/repo', undefined, undefined, undefined,
      { requireGitPush: false },
    );

    expect(results.find(r => r.step === 'workdir')?.ok).toBe(true);
    expect(results.find(r => r.step === 'git')).toMatchObject({ ok: false });
    expect(results.find(r => r.step === 'git')?.message).toContain('fetch/checkout would fail');
    expect(execCmds(runner).some(c => c.includes('git remote get-url origin'))).toBe(true);
    expect(execCmds(runner).some(c => c.includes('git ls-remote'))).toBe(false);
  });

  it('a non-github server project never touches gh', async () => {
    const runner = mockRunner({ 'git remote get-url origin': { stdout: `${GL}\n`, stderr: '', exitCode: 0 } });
    const results = await runPreflight(runner, makeAgent(), GL);
    expect(results.find(r => r.step === 'gh')).toBeUndefined();
    expect(results.find(r => r.step === 'gh-repo')).toBeUndefined();
    expect(execCmds(runner).some(c => c.includes('gh auth') || c.includes('gh api'))).toBe(false);
  });
});

describe('runPreflight — git platform track', () => {
  function gitPlatform(over: Partial<AgentGitPreflight> = {}, projectViewRow: Record<string, unknown> | Error = { defaultBranch: 'main', pushPermitted: true }): AgentGitPreflight {
    return {
      tool: 'gh',
      minToolVersion: '2.40.0',
      agentCommands: [['openssl'], ['shasum', 'sha256sum']],
      steps: [
        { argv: ['{binary}', '--version'], versionCheck: true, fixMessage: '{binary} 需 ≥ {minToolVersion}' },
        { argv: ['{binary}', 'api', 'user'], env: { GH_HOST: '{host}' }, fixMessage: 'run {binary} auth login --hostname {hostname}' },
      ],
      renderCtx: { scheme: 'https', hostname: 'github.com', host: 'github.com', repoPath: 'user/repo', binary: 'gh' },
      driverFor: () => ({
        runOp: async () => {
          if (projectViewRow instanceof Error) throw projectViewRow;
          return [projectViewRow];
        },
      }),
      ...over,
    };
  }

  it('runs driver steps with the tool name as {binary} and asserts push for a dev host', async () => {
    const runner = mockRunner({});
    const results = await runPreflight(runner, makeAgent(), 'git@github.com:user/repo.git', undefined, 'p1', gitPlatform());
    const steps = results.map(r => r.step);
    expect(steps).toContain('driver-preflight-1');
    expect(steps).toContain('platform-repo');
    expect(steps).toContain('platform-push');
    expect(results.find(r => r.step === 'platform-push')?.ok).toBe(true);
    expect(steps).not.toContain('gh');
    expect(steps).not.toContain('gh-repo');
    expect(execCmds(runner).some(c => c.includes("'gh' '--version'"))).toBe(true);
    expect(execCmds(runner).every(c => !c.includes('/opt/'))).toBe(true);
  });

  it('flags a dev host red when the repo is readable but push is not permitted', async () => {
    const runner = mockRunner({});
    const results = await runPreflight(
      runner, makeAgent(), 'git@github.com:user/repo.git', undefined, 'p1',
      gitPlatform({}, { defaultBranch: 'main', pushPermitted: false }),
    );
    const push = results.find(r => r.step === 'platform-push');
    expect(push?.ok).toBe(false);
    expect(push?.message).toContain('push');
  });

  it('keeps a QA host green on missing push permission but red when the repo is unreadable', async () => {
    const runner = mockRunner({});
    const okResults = await runPreflight(
      runner, makeAgent({ role: 'qa' }), 'git@github.com:user/repo.git', undefined, 'p1',
      gitPlatform({}, { defaultBranch: 'main', pushPermitted: false }),
    );
    const push = okResults.find(r => r.step === 'platform-push');
    expect(push?.ok).toBe(true);
    expect(push?.message).toMatch(/QA/);

    const badResults = await runPreflight(
      runner, makeAgent({ role: 'qa' }), 'git@github.com:user/repo.git', undefined, 'p1',
      gitPlatform({}, new Error('HTTP 404')),
    );
    const repoStep = badResults.find(r => r.step === 'platform-repo');
    expect(repoStep?.ok).toBe(false);
  });

  it('warns without failing when the plugin does not map pushPermitted', async () => {
    const runner = mockRunner({});
    const results = await runPreflight(
      runner, makeAgent(), 'git@github.com:user/repo.git', undefined, 'p1',
      gitPlatform({}, { defaultBranch: 'main' }),
    );
    const push = results.find(r => r.step === 'platform-push');
    expect(push?.ok).toBe(true);
    expect(push?.message).toContain('pushPermitted');
  });

  it('skips the repo read when a driver step fails and never runs the legacy gh block', async () => {
    const runner = mockRunner({ "'--version'": FAIL });
    const results = await runPreflight(runner, makeAgent(), 'git@github.com:user/repo.git', undefined, 'p1', gitPlatform());
    expect(results.find(r => r.step === 'driver-preflight-1')?.ok).toBe(false);
    expect(results.some(r => r.step === 'platform-repo')).toBe(false);
    expect(execCmds(runner).every(c => !c.includes('gh auth status'))).toBe(true);
  });

  it('synthesizes the bare-slug probe URL from the host-scoped git_protocol', async () => {
    const sshRunner = mockRunner({ "config get -h 'github.com' git_protocol": { stdout: 'ssh\n', stderr: '', exitCode: 0 } });
    await runPreflight(sshRunner, makeAgent({ workdir: undefined }), 'user/repo', undefined, 'p1', gitPlatform());
    expect(execCmds(sshRunner).some(c => c.includes("git ls-remote 'git@github.com:user/repo.git'"))).toBe(true);

    const httpsRunner = mockRunner({ "config get -h 'github.com' git_protocol": { stdout: 'https\n', stderr: '', exitCode: 0 } });
    await runPreflight(httpsRunner, makeAgent({ workdir: undefined }), 'user/repo', undefined, 'p1', gitPlatform());
    expect(execCmds(httpsRunner).some(c => c.includes("git ls-remote 'https://github.com/user/repo.git'"))).toBe(true);
  });

  it('flags missing plugin-skill runtime deps (openssl / sha256 checksum) on the agent host', async () => {
    const runner = mockRunner({
      'command -v openssl': FAIL,
      'command -v shasum': FAIL,
      'command -v sha256sum': FAIL,
    });
    const results = await runPreflight(runner, makeAgent(), 'git@github.com:user/repo.git', undefined, 'p1', gitPlatform());
    const deps = results.find(r => r.step === 'platform-skill-deps');
    expect(deps?.ok).toBe(false);
    expect(deps?.message).toContain('openssl');
    expect(deps?.message).toContain('sha256sum');
  });

  it('passes the skill-deps probe when openssl and a checksum variant are present', async () => {
    const runner = mockRunner({ 'command -v shasum': FAIL });
    const results = await runPreflight(runner, makeAgent(), 'git@github.com:user/repo.git', undefined, 'p1', gitPlatform());
    expect(results.find(r => r.step === 'platform-skill-deps')?.ok).toBe(true);
  });

  it('folds a rejecting skill-deps probe into a failed check instead of rejecting the whole preflight', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('command -v openssl')) throw new Error('Command timed out after 5000ms');
        if (cmd.includes('rev-parse --show-toplevel')) return OK_TRUE;
        if (cmd.startsWith('command -v')) return OK_PATH;
        if (cmd.includes("'--version'")) return { stdout: 'gh version 2.40.0', stderr: '', exitCode: 0 };
        return OK_EMPTY;
      }),
    };
    const results = await runPreflight(runner, makeAgent(), 'git@github.com:user/repo.git', undefined, 'p1', gitPlatform());
    const deps = results.find(r => r.step === 'platform-skill-deps');
    expect(deps?.ok).toBe(false);
    expect(deps?.message).toContain('timed out');
    expect(results.find(r => r.step === 'platform-repo')).toBeDefined();
  });

  it('probes both configured fetch and push channels for a Workdir publisher', async () => {
    const runner = mockRunner({
      'git remote get-url origin': { stdout: 'https://github.com/user/repo.git\n', stderr: '', exitCode: 0 },
      'git remote get-url --push': { stdout: 'git@github.com:user/repo.git\n', stderr: '', exitCode: 0 },
      "config get -h 'github.com' git_protocol": { stdout: 'https\n', stderr: '', exitCode: 0 },
    });
    await runPreflight(
      runner, makeAgent({ workdir: '/tmp/code' }), 'https://github.com/user/repo.git', undefined, 'p1', gitPlatform(),
      { requireGitPush: true },
    );
    expect(execCmds(runner).some(c => c.includes("git ls-remote 'https://github.com/user/repo.git'"))).toBe(true);
    expect(execCmds(runner).some(c => c.includes("git ls-remote 'git@github.com:user/repo.git'"))).toBe(true);
    expect(execCmds(runner).every(c => !c.includes('config get'))).toBe(true);
  });

  it('probes the gh git_protocol channel for auto workdirs even when the repo is an explicit URL', async () => {
    const runner = mockRunner({ "config get -h 'github.com' git_protocol": { stdout: 'ssh\n', stderr: '', exitCode: 0 } });
    await runPreflight(runner, makeAgent({ workdir: undefined }), 'https://github.com/user/repo.git', undefined, 'p1', gitPlatform());
    expect(execCmds(runner).some(c => c.includes("git ls-remote 'git@github.com:user/repo.git'"))).toBe(true);
  });

  it('fails the git check when the configured Workdir has no push origin', async () => {
    const runner = mockRunner({ 'git remote get-url --push': { stdout: '', stderr: '', exitCode: 1 } });
    const results = await runPreflight(
      runner, makeAgent({ workdir: '/tmp/code' }), 'user/repo', undefined, 'p1', gitPlatform(),
      { requireGitPush: true },
    );
    const git = results.find(r => r.step === 'git');
    expect(git?.ok).toBe(false);
    expect(git?.message).toContain('no push origin');
  });

  it('keeps driver stderr tails out of the checks response', async () => {
    const runner = mockRunner({});
    const results = await runPreflight(
      runner, makeAgent(), 'git@github.com:user/repo.git', undefined, 'p1',
      gitPlatform({
        driverFor: () => ({
          runOp: async () => {
            throw new DriverOpError('op projectView failed (exit 1, class ACCESS_DENIED): token-like-diagnostic=SECRET123', {
              opName: 'projectView', errorClass: 'ACCESS_DENIED', exitCode: 1,
            });
          },
        }),
      }),
    );
    const repoStep = results.find(r => r.step === 'platform-repo');
    expect(repoStep?.ok).toBe(false);
    expect(JSON.stringify(results)).not.toContain('SECRET123');
    expect(repoStep?.message).toContain('ACCESS_DENIED');
  });

  it('treats a resolved exit 255 on the protocol probe as inconclusive, not as an unset config', async () => {
    const runner = mockRunner({
      "config get -h 'github.com' git_protocol": { stdout: '', stderr: 'kex_exchange_identification: read: Connection reset', exitCode: 255 },
    });
    const results = await runPreflight(runner, makeAgent({ workdir: undefined }), 'user/repo', undefined, 'p1', gitPlatform());
    const git = results.find(r => r.step === 'git');
    expect(git?.ok).toBe(false);
    expect(execCmds(runner).every(c => !c.includes('git ls-remote'))).toBe(true);
  });

  it('ignores a probe error in a group that a later alternative satisfies', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('command -v shasum')) throw new Error('Command timed out after 5000ms');
        if (cmd.includes('rev-parse --show-toplevel')) return OK_TRUE;
        if (cmd.startsWith('command -v')) return OK_PATH;
        if (cmd.includes("'--version'")) return { stdout: 'gh version 2.40.0', stderr: '', exitCode: 0 };
        return OK_EMPTY;
      }),
    };
    const results = await runPreflight(runner, makeAgent(), 'git@github.com:user/repo.git', undefined, 'p1', gitPlatform());
    expect(results.find(r => r.step === 'platform-skill-deps')?.ok).toBe(true);
  });

  it('folds a rejecting git_protocol probe into a failed git check without guessing a protocol', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('config get')) throw new Error('transport down');
        if (cmd.includes('rev-parse --show-toplevel')) return OK_TRUE;
        if (cmd.startsWith('command -v')) return OK_PATH;
        if (cmd.includes("'--version'")) return { stdout: 'gh version 2.40.0', stderr: '', exitCode: 0 };
        return OK_EMPTY;
      }),
    };
    const results = await runPreflight(runner, makeAgent({ workdir: undefined }), 'user/repo', undefined, 'p1', gitPlatform());
    const git = results.find(r => r.step === 'git');
    expect(git?.ok).toBe(false);
    expect(git?.message).toContain('transport down');
    expect(execCmds(runner).every(c => !c.includes('git ls-remote'))).toBe(true);
    expect(results.find(r => r.step === 'platform-repo')).toBeDefined();
  });

  it('skips the platform-skill dependency probe for roles that never run those commands', async () => {
    const runner = mockRunner({ 'command -v openssl': FAIL, 'command -v shasum': FAIL, 'command -v sha256sum': FAIL });
    const results = await runPreflight(
      runner, makeAgent({ role: 'qa' }), 'git@github.com:user/repo.git', undefined, 'p1', gitPlatform(),
    );
    expect(results.some(r => r.step === 'platform-skill-deps')).toBe(false);
    expect(execCmds(runner).every(c => !c.includes('command -v openssl'))).toBe(true);
  });

  it('probes nothing for a plugin that declares no agent-side commands', async () => {
    const runner = mockRunner({ 'command -v openssl': FAIL });
    const results = await runPreflight(
      runner, makeAgent(), 'git@github.com:user/repo.git', undefined, 'p1',
      gitPlatform({ agentCommands: [] }),
    );
    expect(results.some(r => r.step === 'platform-skill-deps')).toBe(false);
    expect(execCmds(runner).every(c => !c.includes('command -v openssl'))).toBe(true);
  });

  it('diagnoses an ssh:// origin failure toward SSH, not gh credential setup', async () => {
    const runner = mockRunner({
      'git remote get-url origin': { stdout: 'ssh://git@github.com/user/repo.git\n', stderr: '', exitCode: 0 },
      'git ls-remote': FAIL,
    });
    const results = await runPreflight(
      runner, makeAgent({ workdir: '/tmp/code' }), 'ssh://git@github.com/user/repo.git', undefined, 'p1', gitPlatform(),
    );
    const git = results.find(r => r.step === 'git');
    expect(git?.ok).toBe(false);
    expect(git?.message).toContain('SSH key');
  });

  it('probes a non-gh tool auto workdir with the repo URL verbatim (plain git clone face)', async () => {
    const runner = mockRunner({ "config get -h 'github.com' git_protocol": { stdout: 'ssh\n', stderr: '', exitCode: 0 } });
    await runPreflight(
      runner, makeAgent({ workdir: undefined }), 'https://github.com/user/repo.git', undefined, 'p1',
      gitPlatform({ tool: 'forge' }),
    );
    expect(execCmds(runner).some(c => c.includes("git ls-remote 'https://github.com/user/repo.git'"))).toBe(true);
    expect(execCmds(runner).every(c => !c.includes('config get'))).toBe(true);
  });

  it('falls back to the global git_protocol when the host scope is unset', async () => {
    const runner = mockRunner({
      "config get -h 'github.com' git_protocol": OK_EMPTY,
      'config get git_protocol': { stdout: 'ssh\n', stderr: '', exitCode: 0 },
    });
    await runPreflight(runner, makeAgent({ workdir: undefined }), 'user/repo', undefined, 'p1', gitPlatform());
    expect(execCmds(runner).some(c => c.includes("git ls-remote 'git@github.com:user/repo.git'"))).toBe(true);
  });

  it('probes a non-gh github repo with the repo URL verbatim (plain git clone face)', async () => {
    const runner = mockRunner({});
    await runPreflight(
      runner, makeAgent({ workdir: undefined }), 'https://github.com/user/repo.git', undefined, 'p1',
      gitPlatform({ tool: 'forge' }),
    );
    expect(execCmds(runner).some(c => c.includes("git ls-remote 'https://github.com/user/repo.git'"))).toBe(true);
    expect(execCmds(runner).every(c => !c.includes('config get'))).toBe(true);
  });
});
