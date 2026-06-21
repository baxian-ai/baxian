import { describe, it, expect } from 'vitest';
import { mkdtemp, access, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner, ExecOptions, ExecResult } from '../../src/agent/runner.js';
import { LocalRunner, SshRunner, buildSshOptions, shellQuote, wrapRemoteCommand } from '../../src/agent/runner.js';

describe('shellQuote', () => {
  it('single-quotes input and escapes embedded single quotes via close-escape-reopen', () => {
    expect.soft(shellQuote('hello'), 'plain string').toBe("'hello'");
    expect.soft(shellQuote("it's"), 'escapes single quotes').toBe("'it'\\''s'");
    expect.soft(shellQuote('path with spaces'), 'preserves spaces').toBe("'path with spaces'");
    expect.soft(shellQuote(''), 'empty string').toBe("''");
  });
});

describe('wrapRemoteCommand', () => {
  it.each<[string, Parameters<typeof wrapRemoteCommand>, string]>([
    [
      'defaults to login non-interactive (-l -c) so .zprofile loads but .zshrc is skipped (avoids stdout banner pollution)',
      ['which claude'],
      `sh -c 'exec "\${SHELL:-/bin/sh}" -l -c "$1"' _ 'which claude'`,
    ],
    [
      'opt-in login-interactive (-l -i -c) covers .zshrc PATH (nvm / $HOME/.local/bin)',
      ['which claude', 'login-interactive'],
      `sh -c 'exec "\${SHELL:-/bin/sh}" -l -i -c "$1"' _ 'which claude'`,
    ],
    [
      'explicit login mode is identical to default',
      ['echo hi', 'login'],
      `sh -c 'exec "\${SHELL:-/bin/sh}" -l -c "$1"' _ 'echo hi'`,
    ],
    [
      'escapes single quotes inside the inner command',
      ["echo it's"],
      `sh -c 'exec "\${SHELL:-/bin/sh}" -l -c "$1"' _ 'echo it'\\''s'`,
    ],
    [
      'handles empty command',
      [''],
      `sh -c 'exec "\${SHELL:-/bin/sh}" -l -c "$1"' _ ''`,
    ],
  ])('%s', (_name, args, expected) => {
    expect(wrapRemoteCommand(...args)).toBe(expected);
  });

  it('outer sh is a literal command name (not a variable) so login shells like fish accept it; sh expands $SHELL via POSIX rules and exec-replaces itself', () => {
    expect(wrapRemoteCommand('whoami')).toMatch(/^sh -c '/);
    expect(wrapRemoteCommand('whoami')).toContain('exec "${SHELL:-/bin/sh}"');
  });

  it('passes the inner command via positional $1 so embedded $VARs / quotes are not re-evaluated by the outer sh', () => {
    expect(wrapRemoteCommand('echo $HOME')).toContain(`'echo $HOME'`);
    expect(wrapRemoteCommand('echo $HOME')).toContain(`"$1"`);
  });

  it('uses separate -l / -i / -c short options (not combined -lic) so shells like fish that do not group short flags still work', () => {
    expect(wrapRemoteCommand('whoami')).toContain('-l -c');
    expect(wrapRemoteCommand('whoami', 'login-interactive')).toContain('-l -i -c');
    expect(wrapRemoteCommand('whoami')).not.toContain('-lc"');
    expect(wrapRemoteCommand('whoami', 'login-interactive')).not.toContain('-lic"');
  });
});

describe('LocalRunner', () => {
  it('executes a command and returns stdout', async () => {
    const runner = new LocalRunner();
    const result = await runner.exec('echo hello');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });
  it('returns non-zero exit code on failure', async () => {
    const runner = new LocalRunner();
    const result = await runner.exec('exit 42');
    expect(result.exitCode).toBe(42);
  });
  it('captures stderr', async () => {
    const runner = new LocalRunner();
    const result = await runner.exec('echo err >&2');
    expect(result.stderr.trim()).toBe('err');
  });
  it('preserves shell semantics — pipes', async () => {
    const runner = new LocalRunner();
    const result = await runner.exec('printf "a\\nb\\nc\\n" | grep b');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('b');
  });
  it('preserves shell semantics — &&', async () => {
    const runner = new LocalRunner();
    const result = await runner.exec('echo a && echo b');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('a\nb');
  });

  describe('timeout option', () => {
    it('kills process after timeout and rejects', async () => {
      const runner = new LocalRunner();
      await expect(
        runner.exec('sleep 5', { timeout: 100 }),
      ).rejects.toThrow(/timed out/i);
    });

    it('does not affect commands that complete in time', async () => {
      const runner = new LocalRunner();
      const result = await runner.exec('echo fast', { timeout: 5000 });
      expect(result.stdout.trim()).toBe('fast');
    });
  });

  describe('maxBuffer option', () => {
    it('rejects when stdout exceeds maxBuffer', async () => {
      const runner = new LocalRunner();
      await expect(
        runner.exec('printf "%s" "$(yes a | head -c 10000)"', { maxBuffer: 1024 }),
      ).rejects.toThrow(/maxBuffer/i);
    });

    it('does not affect commands within the limit', async () => {
      const runner = new LocalRunner();
      const result = await runner.exec('echo small', { maxBuffer: 1024 });
      expect(result.stdout.trim()).toBe('small');
    });
  });

  describe('child stdin closure', () => {
    it('closes child stdin immediately so a remote shell `read` does not block until timeout', async () => {
      const runner = new LocalRunner();
      const t0 = Date.now();
      const result = await runner.exec('read x; echo done', { timeout: 1500 });
      const elapsed = Date.now() - t0;
      expect(result.stdout.trim()).toBe('done');
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('process tree kill', () => {
    it('terminates the whole tree on timeout, not just /bin/bash', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'runner-tree-'));
      const marker = join(dir, 'created');
      const runner = new LocalRunner();
      await expect(
        runner.exec(`sh -c 'sleep 1; touch ${marker}'`, { timeout: 100 }),
      ).rejects.toThrow(/timed out/i);
      await new Promise(r => setTimeout(r, 1500));
      await expect(access(marker)).rejects.toThrow();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe('AbortSignal option', () => {
    it('aborts running command when signal fires', async () => {
      const runner = new LocalRunner();
      const controller = new AbortController();
      const promise = runner.exec('sleep 5', { signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      await expect(promise).rejects.toThrow();
    });

    it('rejects immediately when signal is already aborted', async () => {
      const runner = new LocalRunner();
      const controller = new AbortController();
      controller.abort();
      await expect(
        runner.exec('echo hi', { signal: controller.signal }),
      ).rejects.toThrow();
    });
  });
});

function captureLocal(
  execImpl?: (cmd: string, options?: ExecOptions) => Promise<ExecResult>,
): {
  runner: CommandRunner;
  calls: Array<{ cmd: string; options?: ExecOptions; stdin?: Buffer }>;
} {
  const calls: Array<{ cmd: string; options?: ExecOptions; stdin?: Buffer }> = [];
  const runner: CommandRunner = {
    exec: async (cmd: string, options?: ExecOptions): Promise<ExecResult> => {
      calls.push({ cmd, options });
      if (execImpl) return execImpl(cmd, options);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    writeFile: async () => { /* unused in exec-only specs */ },
    execWithStdin: async (cmd: string, stdin: Buffer, options?: ExecOptions): Promise<ExecResult> => {
      calls.push({ cmd, options, stdin });
      if (execImpl) return execImpl(cmd, options);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  return { runner, calls };
}

describe('SshRunner', () => {
  it('prefixes target with user@ when host.user is set', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box', user: 'rock' }, local);
    await ssh.exec('whoami');
    expect(calls[0].cmd).toContain("'rock@box'");
  });

  it('omits user@ prefix when host.user is undefined (~/.ssh/config takes over)', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.exec('whoami');
    expect(calls[0].cmd).toContain("'box'");
    expect(calls[0].cmd).not.toContain("'undefined@");
  });

  it('inserts -- before the destination so a target starting with "-" is not parsed as an option', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box', user: 'rock' }, local);
    await ssh.exec('whoami');
    expect(calls[0].cmd).toMatch(/ -- 'rock@box'/);
  });

  it('passes timeout option through to the local runner', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box', user: 'rock' }, local);
    await ssh.exec('whoami', { timeout: 123 });
    expect(calls[0].options).toEqual({ timeout: 123 });
  });

  it('embeds ServerAliveInterval/ServerAliveCountMax to detect dead connections', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.exec('whoami');
    expect(calls[0].cmd).toContain('ServerAliveInterval=2');
    expect(calls[0].cmd).toContain('ServerAliveCountMax=2');
  });

  it('embeds ControlMaster mux options so back-to-back short commands reuse one TCP+SSH session', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.exec('whoami');
    expect(calls[0].cmd).toContain('-o ControlMaster=auto');
    expect(calls[0].cmd).toMatch(/-o ControlPath=\S+\/cm-%C/);
    expect(calls[0].cmd).toContain('-o ControlPersist=5m');
  });

  it('default remote shell is login non-interactive (-l -c) so .zshrc cannot pollute stdout for parsing-heavy callers (RepoStore $HOME etc.)', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.exec('which claude');
    expect(calls[0].cmd).toContain('-l -c');
    expect(calls[0].cmd).not.toContain('-i -c');
    expect(calls[0].cmd).toContain('which claude');
  });

  it('opt-in remoteShell:"login-interactive" switches to -l -i -c so probe / preflight which X can find nvm / .local/bin', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.exec('which claude', { remoteShell: 'login-interactive' });
    expect(calls[0].cmd).toContain('-l -i -c');
  });

  it('keeps the inner command quoted so locally undefined $VARs are expanded by the remote shell', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.exec('echo $HOME');
    expect(calls[0].cmd).toContain('echo $HOME');
    expect(calls[0].cmd).toContain('sh -c');
  });

  it('reuses identical ssh option string across back-to-back calls so the second invocation hits the existing mux socket', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.exec('whoami');
    await ssh.exec('hostname');
    const optsFromFirst = calls[0].cmd.split(' -- ')[0];
    const optsFromSecond = calls[1].cmd.split(' -- ')[0];
    expect(optsFromFirst).toBe(optsFromSecond);
  });

  it('buildSshOptions exposes ConnectTimeout knob — probe uses 5s, default 10s, mux flags remain', () => {
    expect(buildSshOptions(undefined)).toContain('-o ConnectTimeout=10');
    expect(buildSshOptions(undefined, { connectTimeoutSec: 5 })).toContain('-o ConnectTimeout=5');
    expect(buildSshOptions(undefined, { connectTimeoutSec: 5 })).toContain('-o ControlMaster=auto');
  });

  it('shell-quotes the ControlPath so a HOME with spaces stays one argv (not word-split into multiple ssh args)', () => {
    const opts = buildSshOptions(undefined);
    // ControlPath value lives between single quotes — bash strips them, ssh receives the
    // full path as a single argv even if HOME contained "/Users/Some User/...".
    expect(opts).toMatch(/-o ControlPath='[^']+\/cm-%C'/);
    // No bare unquoted ControlPath would slip a space-containing path past bash unscathed.
    expect(opts).not.toMatch(/-o ControlPath=[^'][^ ]*\/cm-%C/);
  });

  it('ensureMuxDir caches the success singleton; __resetMuxDirReadyForTests rebuilds it (mirror of catch-handler reset on mkdir failure)', async () => {
    const runnerNs = await import('../../src/agent/runner.js');
    runnerNs.__resetMuxDirReadyForTests();
    const p1 = runnerNs.ensureMuxDir();
    const p2 = runnerNs.ensureMuxDir();
    expect(p2).toBe(p1);
    await p1;
    runnerNs.__resetMuxDirReadyForTests();
    const p3 = runnerNs.ensureMuxDir();
    expect(p3).not.toBe(p1);
    await p3;
  });

  it('passes timeout and signal options through to the underlying local runner', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    const controller = new AbortController();
    await ssh.exec('whoami', { timeout: 500, signal: controller.signal });
    expect(calls[0]?.options?.timeout).toBe(500);
    expect(calls[0]?.options?.signal).toBe(controller.signal);
  });
});

describe('closeSshMux (shutdown convergence)', () => {
  it('runs `ssh -O exit` against each tracked mux target so masters do not linger past process death', async () => {
    const runnerNs = await import('../../src/agent/runner.js');
    runnerNs.__resetMuxTargetsForTests();
    const { runner: local } = captureLocal();
    await new SshRunner({ hostname: 'box', user: 'rock' }, local).exec('whoami');
    await new SshRunner({ hostname: 'other' }, local).exec('whoami');

    const { runner: closer, calls } = captureLocal();
    await runnerNs.closeSshMux(closer);

    const exitCmds = calls.filter(c => c.cmd.includes('-O exit'));
    expect(exitCmds).toHaveLength(2);
    expect(exitCmds.some(c => c.cmd.includes("'rock@box'"))).toBe(true);
    expect(exitCmds.some(c => c.cmd.includes("'other'"))).toBe(true);
    expect(exitCmds[0].cmd).toMatch(/-o ControlPath=\S+\/cm-%C/);

    // Targets are cleared after convergence — a second close is a no-op.
    const { runner: closer2, calls: calls2 } = captureLocal();
    await runnerNs.closeSshMux(closer2);
    expect(calls2).toHaveLength(0);
  });
});

describe('LocalRunner.writeFile', () => {
  it('writes string content and creates nested parent directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-wf-'));
    const target = join(dir, 'a', 'b', 'c', 'note.txt');
    const runner = new LocalRunner();
    await runner.writeFile(target, 'hello world');
    const onDisk = await readFile(target, 'utf8');
    expect(onDisk).toBe('hello world');
    await rm(dir, { recursive: true, force: true });
  });

  it('writes Buffer content with byte-level fidelity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-wf-'));
    const target = join(dir, 'binary.bin');
    const runner = new LocalRunner();
    const payload = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80]);
    await runner.writeFile(target, payload);
    const onDisk = await readFile(target);
    expect(onDisk.equals(payload)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('writes string content with byte-level fidelity (utf8)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-wf-'));
    const target = join(dir, 'utf8.txt');
    const runner = new LocalRunner();
    const text = '中文 + emoji 🚀 + special $`\'"';
    await runner.writeFile(target, text);
    const onDisk = await readFile(target);
    expect(onDisk.equals(Buffer.from(text, 'utf8'))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('overwrites existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-wf-'));
    const target = join(dir, 'note.txt');
    const runner = new LocalRunner();
    await runner.writeFile(target, 'first');
    await runner.writeFile(target, 'second');
    const onDisk = await readFile(target, 'utf8');
    expect(onDisk).toBe('second');
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a 30 KB payload (size boundary, no chunking required)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-wf-'));
    const target = join(dir, 'large.bin');
    const runner = new LocalRunner();
    const payload = Buffer.alloc(30 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    await runner.writeFile(target, payload);
    const info = await stat(target);
    expect(info.size).toBe(payload.length);
    const onDisk = await readFile(target);
    expect(onDisk.equals(payload)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('SshRunner.writeFile', () => {
  it('emits a single base64-decode heredoc command via exec', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box', user: 'rock' }, local);
    await ssh.writeFile('/tmp/baxian/foo.txt', 'hello');
    expect(calls.length).toBe(1);
    const cmd = calls[0].cmd;
    expect(cmd).toContain('mkdir -p');
    expect(cmd).toContain('openssl base64 -d -A > ');
    expect(cmd).not.toContain('base64 --decode');
    expect(cmd).not.toContain('base64 -d > ');
    // The heredoc is wrapped in `sh -c` so a fish login shell can't break it (fish has no heredocs);
    // the path is inner-quoted by that wrap, so assert presence rather than exact outer quoting.
    expect(cmd).toContain('sh -c');
    expect(cmd).toContain('/tmp/baxian/foo.txt');
    expect(cmd).toContain('/tmp/baxian');
  });

  it('uses a heredoc marker with BAXIAN_EOF_ prefix and random suffix', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.writeFile('/tmp/x', 'data');
    const cmd = calls[0].cmd;
    const match = cmd.match(/BAXIAN_EOF_[0-9a-f]{8}/g);
    expect(match).not.toBeNull();
    expect((match ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('produces a different heredoc marker per call (random suffix)', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.writeFile('/tmp/x', 'data');
    await ssh.writeFile('/tmp/y', 'data');
    const m1 = calls[0].cmd.match(/BAXIAN_EOF_([0-9a-f]{8})/);
    const m2 = calls[1].cmd.match(/BAXIAN_EOF_([0-9a-f]{8})/);
    expect(m1?.[1]).toBeDefined();
    expect(m2?.[1]).toBeDefined();
    expect(m1?.[1]).not.toBe(m2?.[1]);
  });

  it.each<[string, string]>([
    ['embeds base64 payload inside the heredoc body', 'hello world'],
    ['treats string content as utf8 and base64-encodes the utf8 bytes', '中文 🚀'],
  ])('%s', async (_name, text) => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.writeFile('/tmp/x', text);
    const expectedB64 = Buffer.from(text, 'utf8').toString('base64');
    expect(calls[0].cmd).toContain(expectedB64);
  });

  it('encodes shell-special and binary bytes losslessly via base64 (decoded equals input)', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    const payload = Buffer.from([0x27, 0x24, 0x60, 0x0a, 0x00, 0xff, 0x7f, 0x41]);
    await ssh.writeFile('/tmp/x', payload);
    const cmd = calls[0].cmd;
    const expectedB64 = payload.toString('base64');
    expect(cmd).toContain(expectedB64);
    const decoded = Buffer.from(expectedB64, 'base64');
    expect(decoded.equals(payload)).toBe(true);
  });

  it('runs mkdir -p on the parent directory of the target path', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.writeFile('/srv/baxian/skills/foo/SKILL.md', 'x');
    expect(calls[0].cmd).toContain(shellQuote('/srv/baxian/skills/foo'));
  });

  it('throws including stderr when remote exec returns non-zero exit code', async () => {
    const { runner: local } = captureLocal(async () => ({
      stdout: '',
      stderr: 'permission denied',
      exitCode: 1,
    }));
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await expect(ssh.writeFile('/etc/forbidden', 'x')).rejects.toThrow(/permission denied/);
    await expect(ssh.writeFile('/etc/forbidden', 'x')).rejects.toThrow(/\/etc\/forbidden/);
  });
});

describe('LocalRunner.execWithStdin (bypass ARG_MAX for tmux load-buffer)', () => {
  it('writes stdin Buffer to spawned process and returns its stdout', async () => {
    const local = new LocalRunner();
    const payload = Buffer.from('hello world\n', 'utf8');
    const result = await local.execWithStdin('cat', payload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
  });

  it('passes large payloads (>1MB) through stdin without ARG_MAX failures', async () => {
    const local = new LocalRunner();
    // 1.5MB payload (above macOS / Linux ARG_MAX of ~1MB for argv)
    const big = Buffer.alloc(1.5 * 1024 * 1024, 65); // 'A' bytes
    const result = await local.execWithStdin('wc -c', big);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(String(big.length));
  });

  it('handles arbitrary bytes including null and control characters via stdin', async () => {
    const local = new LocalRunner();
    // \x00\x01\x02 ... 0xff
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const result = await local.execWithStdin('wc -c', bytes);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('256');
  });
});

describe('SshRunner.execWithStdin (login shell + stdin pipe)', () => {
  it('forwards stdin Buffer to underlying local exec via wrapped login shell', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    const payload = Buffer.from('payload', 'utf8');
    await ssh.execWithStdin('tmux load-buffer -b X -', payload);
    expect(calls).toHaveLength(1);
    expect(calls[0].stdin).toEqual(payload);
    // wrapped via login shell (matches existing exec() behavior)
    expect(calls[0].cmd).toContain('sh -c');
    expect(calls[0].cmd).toContain('tmux load-buffer');
  });
});

describe('SshRunner.execRawRemoteWithStdin (raw path, no login shell)', () => {
  it('does NOT wrap with wrapRemoteCommand (no `sh -c -l -c` on the remote side)', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    await ssh.execRawRemoteWithStdin('tmux load-buffer -b X -', Buffer.from('data'));
    expect(calls).toHaveLength(1);
    // The local-side ssh command does not contain login-shell wrapping markers
    // (no `sh -c '...exec "${SHELL...' wrapper inside the ssh args).
    expect(calls[0].cmd).not.toContain('exec "${SHELL');
    expect(calls[0].cmd).not.toContain('-l -c');
    expect(calls[0].cmd).not.toContain('-l -i -c');
    // But still uses ssh + the raw remote command quoted
    expect(calls[0].cmd).toMatch(/^ssh /);
    expect(calls[0].cmd).toContain("'tmux load-buffer -b X -'");
  });

  it('passes target via shellQuote with `--` separator', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box', user: 'deploy' }, local);
    await ssh.execRawRemoteWithStdin('whoami', Buffer.from(''));
    expect(calls[0].cmd).toContain("-- 'deploy@box'");
  });

  it('forwards stdin Buffer untouched to local exec', async () => {
    const { runner: local, calls } = captureLocal();
    const ssh = new SshRunner({ hostname: 'box' }, local);
    const payload = Buffer.from([0, 1, 2, 3, 4, 5]);
    await ssh.execRawRemoteWithStdin('cat', payload);
    expect(calls[0].stdin).toEqual(payload);
  });
});
