import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { probeTmux, runPreflight } from '../../src/agent/preflight.js';
import { LocalRunner } from '../../src/agent/runner.js';
import * as runnerModule from '../../src/agent/runner.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
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
      if (cmd.includes('rev-parse --is-inside-work-tree')) return OK_TRUE;
      if (cmd.startsWith('command -v')) return OK_PATH;
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
    expect(results.length).toBeGreaterThanOrEqual(6);
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

  it('skips openssl check for local agents (LocalRunner.writeFile uses fs)', async () => {
    const runner = mockRunner({ 'command -v openssl': FAIL });
    const results = await runPreflight(runner, makeAgent(), 'user/repo');
    expect(results.find(r => r.step === 'openssl')).toBeUndefined();
  });

  it('detects missing openssl on remote agents (SshRunner.writeFile decodes via openssl)', async () => {
    vi.spyOn(LocalRunner.prototype, 'exec').mockResolvedValue({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    const remoteAgent = makeAgent({
      mode: 'remote',
      host: { hostname: 'remote.example.com', user: 'agent' },
    });
    const runner = mockRunner({ 'command -v openssl': FAIL });
    const results = await runPreflight(runner, remoteAgent, 'user/repo', { hostname: 'remote.example.com', user: 'agent' });
    const openssl = results.find(r => r.step === 'openssl');
    expect(openssl?.ok).toBe(false);
    expect(openssl?.message).toContain('install openssl');
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

  it('passes openssl check on remote agents when available', async () => {
    vi.spyOn(LocalRunner.prototype, 'exec').mockResolvedValue({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    const remoteAgent = makeAgent({
      mode: 'remote',
      host: { hostname: 'remote.example.com', user: 'agent' },
    });
    const runner = mockRunner({});
    const results = await runPreflight(runner, remoteAgent, 'user/repo', { hostname: 'remote.example.com', user: 'agent' });
    expect(results.find(r => r.step === 'openssl')?.ok).toBe(true);
  });

  it('detects bad workdir', async () => {
    const runner = mockRunner({ 'rev-parse --is-inside-work-tree': FAIL });
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
    const results = await runPreflight(runner, makeAgent(), 'user/repo');
    expect(results.find(r => r.step === 'gh')?.ok).toBe(false);
  });

  it('detects repo access failure via gh api', async () => {
    const runner = mockRunner({ 'gh api repos/': FAIL });
    const results = await runPreflight(runner, makeAgent(), 'user/repo');
    expect(results.find(r => r.step === 'gh-repo')?.ok).toBe(false);
  });

  it('binary probes match the runtime mode of each binary: claude/codex use login-interactive (tmux pane); tmux/openssl + other ops stay on default login (-lc)', async () => {
    vi.spyOn(LocalRunner.prototype, 'exec').mockResolvedValue({ stdout: 'ok\n', stderr: '', exitCode: 0 });

    const calls: Array<{ cmd: string; opts?: { remoteShell?: string } }> = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string, opts?: { remoteShell?: string }) => {
        calls.push({ cmd, opts });
        if (cmd.includes('rev-parse --is-inside-work-tree')) return OK_TRUE;
        if (cmd.startsWith('command -v')) return OK_PATH;
        return OK_EMPTY;
      }),
    };
    await runPreflight(runner, makeAgent({ mode: 'remote', host: { hostname: 'box', user: 'rock' } }), 'user/repo', { hostname: 'box', user: 'rock' });

    const cliWhich = calls.find(c => c.cmd === 'command -v claude');
    expect(cliWhich?.opts?.remoteShell).toBe('login-interactive');

    const tmuxWhich = calls.find(c => c.cmd === 'command -v tmux');
    expect(tmuxWhich?.opts?.remoteShell).toBeUndefined();

    const opensslWhich = calls.find(c => c.cmd === 'command -v openssl');
    expect(opensslWhich?.opts?.remoteShell).toBeUndefined();

    const otherCalls = calls.filter(c => /^(git |gh |mkdir |test )/.test(c.cmd));
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

  it('cli/tmux/openssl probe rejection (timeout / abort / spawn error) is converted into a per-step failure result, not propagated as a thrown error that would 500 the /projects/:id/checks API', async () => {
    vi.spyOn(LocalRunner.prototype, 'exec').mockResolvedValue({ stdout: 'ok\n', stderr: '', exitCode: 0 });

    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === 'command -v claude') {
          throw new Error('Command timed out after 5000ms');
        }
        if (cmd === 'command -v tmux') {
          throw new Error('Command timed out after 5000ms');
        }
        if (cmd === 'command -v openssl') {
          throw new Error('spawn ssh ENOENT');
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
    expect(cli?.message).toMatch(/timed out/i);

    const tmux = results.find(r => r.step === 'tmux');
    expect(tmux?.ok).toBe(false);
    expect(tmux?.message).toMatch(/timed out/i);

    const openssl = results.find(r => r.step === 'openssl');
    expect(openssl?.ok).toBe(false);
    expect(openssl?.message).toMatch(/probe failed/i);
    expect(openssl?.message).toMatch(/spawn ssh ENOENT/);
  });
});

function makeAutoAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { id: 'dev-auto', runtime: 'claude-code', role: 'dev', mode: 'local', ...overrides };
}

describe('runPreflight — auto mode', () => {
  it('runs mkdir -p ~/.baxian/repos and test -w on parent', async () => {
    const runner = mockRunner({});
    await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const calls = execCmds(runner);
    expect(calls.some(c => c.includes('mkdir -p') && c.includes('.baxian/repos'))).toBe(true);
    expect(calls.some(c => c.includes('test -w') && c.includes('.baxian/repos'))).toBe(true);
  });

  it('lowercases the slug in absRepoPath so it stays consistent with RepoStore.resolveAbsPath', async () => {
    const runner = mockRunner({});
    await runPreflight(runner, makeAutoAgent(), 'Owner/Repo');
    const calls = execCmds(runner);
    expect(calls.some(c => c.includes('test -d ~/.baxian/repos/owner/repo'))).toBe(true);
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
        if (cmd.startsWith('mkdir -p') && cmd.includes('.baxian/repos &&')) return OK_EMPTY;
        if (cmd === `test -d ~/.baxian/repos/user/repo`) return OK_EMPTY;
        if (cmd.includes('rev-parse --resolve-git-dir')) return FAIL;
        if (cmd.startsWith('command -v')) return OK_PATH;
        return OK_EMPTY;
      }),
    };
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const wd = results.find(r => r.step === 'workdir');
    expect(wd?.ok).toBe(false);
    expect(wd?.message).toMatch(/not a git/i);
  });

  it('passes workdir when existing repo dir is a valid git repo', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.startsWith('mkdir -p')) return OK_EMPTY;
        if (cmd === `test -d ~/.baxian/repos/user/repo`) return OK_EMPTY;
        if (cmd.includes('rev-parse --resolve-git-dir')) return OK_EMPTY;
        if (cmd.startsWith('command -v')) return OK_PATH;
        return OK_EMPTY;
      }),
    };
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const wd = results.find(r => r.step === 'workdir');
    expect(wd?.ok).toBe(true);
  });

  it('passes workdir for a bare managed store (no .git subdirectory)', async () => {
    const probes: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.startsWith('mkdir -p')) return OK_EMPTY;
        if (cmd === `test -d ~/.baxian/repos/user/repo`) return OK_EMPTY;
        if (cmd.includes('rev-parse --resolve-git-dir')) {
          probes.push(cmd);
          return OK_EMPTY;
        }
        if (cmd === `test -d ~/.baxian/repos/user/repo/.git`) return FAIL;
        if (cmd.startsWith('command -v')) return OK_PATH;
        return OK_EMPTY;
      }),
    };
    const results = await runPreflight(runner, makeAutoAgent(), 'user/repo');
    const wd = results.find(r => r.step === 'workdir');
    expect(wd?.ok).toBe(true);
    expect(probes.length).toBeGreaterThan(0);
  });

  it('passes workdir when nothing exists yet (clone will create it)', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.startsWith('mkdir -p')) return OK_EMPTY;
        if (cmd === `test -d ~/.baxian/repos/user/repo`) return FAIL;
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

  it('manual mode: skips gh checks, probes access via git ls-remote on the full URL', async () => {
    const runner = mockRunner({});
    const results = await runPreflight(runner, makeAgent(), GL);
    expect(results.find(r => r.step === 'gh')).toBeUndefined();
    expect(results.find(r => r.step === 'gh-repo')).toBeUndefined();
    const cmds = execCmds(runner);
    expect(cmds.some(c => c.includes('gh auth') || c.includes('gh api'))).toBe(false);
    expect(cmds.some(c => c.includes('git ls-remote') && c.includes(GL))).toBe(true);
    expect(results.find(r => r.step === 'git')?.ok).toBe(true);
  });

  it('auto mode: uses repos-ext/<host>/<path> and git ls-remote, never gh', async () => {
    const runner = mockRunner({});
    await runPreflight(runner, makeAgent({ workdir: undefined }), GL);
    const cmds = execCmds(runner);
    expect(cmds.some(c => c.includes('.baxian/repos-ext/gitlab.example.com/group/proj'))).toBe(true);
    expect(cmds.some(c => c.includes('gh config get git_protocol'))).toBe(false);
    expect(cmds.some(c => c.includes('gh auth') || c.includes('gh api'))).toBe(false);
    expect(cmds.some(c => c.includes('git ls-remote') && c.includes(GL))).toBe(true);
  });

  it('auto mode: a malicious host throws before building any shell command (no injection)', async () => {
    const runner = mockRunner({});
    const evil = 'https://gitlab.example.com;touch pwned/group/proj.git';
    await expect(runPreflight(runner, makeAgent({ workdir: undefined }), evil)).rejects.toThrow(/unsafe host/i);
    const cmds = execCmds(runner);
    expect(cmds.some(c => c.includes(';touch pwned'))).toBe(false);
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

  it('github repo still runs gh auth + gh api (regression anchor)', async () => {
    const runner = mockRunner({});
    const results = await runPreflight(runner, makeAgent(), 'user/repo');
    expect(results.find(r => r.step === 'gh')).toBeDefined();
    expect(results.find(r => r.step === 'gh-repo')).toBeDefined();
  });
});
