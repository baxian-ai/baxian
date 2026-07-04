import { describe, it, expect } from 'vitest';
import { installTmux } from '../../src/agent/tmux-install.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'not found', exitCode = 1): ExecResult => ({ stdout: '', stderr, exitCode });

type Handler = (cmd: string) => ExecResult | undefined;

function fakeRunner(handler: Handler): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner = {
    exec: async (cmd: string) => {
      calls.push(cmd);
      const result = handler(cmd);
      if (!result) throw new Error(`unexpected command: ${cmd}`);
      return result;
    },
    writeFile: async () => {},
    execWithStdin: async () => ok(),
  };
  return { runner, calls };
}

interface MacOptions {
  brewOnPath?: boolean;
  brewAtCandidate?: string;
  installExit?: number;
  tmuxAfterInstall?: boolean;
}

function macHost(opts: MacOptions = {}) {
  let installed = false;
  const tmuxAfter = opts.tmuxAfterInstall ?? true;
  return fakeRunner(cmd => {
    if (cmd === 'command -v tmux') return installed && tmuxAfter ? ok('/opt/homebrew/bin/tmux\n') : fail();
    if (cmd === 'tmux -V') return installed && tmuxAfter ? ok('tmux 3.5a\n') : fail();
    if (cmd === 'uname -s') return ok('Darwin\n');
    if (cmd === 'command -v brew') return opts.brewOnPath ? ok('/opt/homebrew/bin/brew\n') : fail();
    if (cmd.startsWith('test -x ')) {
      return opts.brewAtCandidate && cmd === `test -x ${opts.brewAtCandidate}` ? ok() : fail();
    }
    if (cmd.includes('brew install tmux')) {
      if ((opts.installExit ?? 0) === 0) {
        installed = true;
        return ok('installed');
      }
      return fail('brew boom', opts.installExit);
    }
    return undefined;
  });
}

interface LinuxOptions {
  uid?: string;
  sudoOk?: boolean;
  managers?: string[];
  installExit?: number;
  failFirstInstall?: boolean;
  tmuxAfterInstall?: boolean;
}

function linuxHost(opts: LinuxOptions = {}) {
  let installed = false;
  let installAttempts = 0;
  const managers = opts.managers ?? ['apt-get'];
  const tmuxAfter = opts.tmuxAfterInstall ?? true;
  return fakeRunner(cmd => {
    if (cmd === 'command -v tmux') return installed && tmuxAfter ? ok('/usr/bin/tmux\n') : fail();
    if (cmd === 'tmux -V') return installed && tmuxAfter ? ok('tmux 3.4\n') : fail();
    if (cmd === 'uname -s') return ok('Linux\n');
    if (cmd === 'id -u') return ok(`${opts.uid ?? '0'}\n`);
    if (cmd === 'sudo -n true') return opts.sudoOk ? ok() : fail('sudo: a password is required');
    if (cmd.startsWith('command -v ')) {
      const name = cmd.slice('command -v '.length);
      return managers.includes(name) ? ok(`/usr/bin/${name}\n`) : fail();
    }
    if (cmd.endsWith('apt-get update')) return ok();
    if (/apt-get install|dnf install|yum install|pacman -S|zypper.*install|apk add/.test(cmd)) {
      installAttempts += 1;
      if ((opts.installExit ?? 0) !== 0) return fail('install boom', opts.installExit);
      if (opts.failFirstInstall && installAttempts === 1) return fail('index out of date', 100);
      installed = true;
      return ok();
    }
    return undefined;
  });
}

describe('installTmux', () => {
  it('short-circuits when tmux is already installed', async () => {
    const { runner, calls } = fakeRunner(cmd =>
      cmd === 'command -v tmux' ? ok('/usr/bin/tmux\n') : undefined,
    );
    const result = await installTmux(runner);
    expect(result.ok).toBe(true);
    expect(result.method).toBe('already-installed');
    expect(result.message).toContain('/usr/bin/tmux');
    expect(calls).toEqual(['command -v tmux']);
  });

  it('fails on an unsupported platform', async () => {
    const { runner } = fakeRunner(cmd => {
      if (cmd === 'command -v tmux') return fail();
      if (cmd === 'uname -s') return ok('FreeBSD\n');
      return undefined;
    });
    const result = await installTmux(runner);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('unsupported platform "FreeBSD"');
  });

  it('never reports success when a probe command throws (e.g. timeout)', async () => {
    const { runner } = fakeRunner(cmd => (cmd === 'command -v tmux' ? fail() : undefined));
    const result = await installTmux(runner);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('tmux install failed');
  });

  describe('macOS', () => {
    it('installs via brew on PATH with non-interactive env and verifies the version', async () => {
      const { runner, calls } = macHost({ brewOnPath: true });
      const result = await installTmux(runner);
      expect(result).toMatchObject({ ok: true, method: 'brew', version: '3.5' });
      expect(result.message).toBe('tmux 3.5 installed via brew');
      const install = calls.find(c => c.includes('brew install tmux'));
      expect(install).toBe(
        'HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 /opt/homebrew/bin/brew install tmux',
      );
    });

    it('falls back to well-known brew locations when brew is not on PATH', async () => {
      const { runner, calls } = macHost({ brewAtCandidate: '/usr/local/bin/brew' });
      const result = await installTmux(runner);
      expect(result.ok).toBe(true);
      expect(calls.some(c => c.includes('/usr/local/bin/brew install tmux'))).toBe(true);
    });

    it('fails with Homebrew guidance when brew is absent, without attempting an install', async () => {
      const { runner, calls } = macHost();
      const result = await installTmux(runner);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('https://brew.sh');
      expect(calls.some(c => c.includes('install tmux'))).toBe(false);
    });

    it('reports a failed brew install with its exit code', async () => {
      const { runner } = macHost({ brewOnPath: true, installExit: 1 });
      const result = await installTmux(runner);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('brew install tmux failed (exit 1)');
      expect(result.message).toContain('brew boom');
    });

    it('does not report success when tmux is still missing after a "successful" install', async () => {
      const { runner } = macHost({ brewOnPath: true, tmuxAfterInstall: false });
      const result = await installTmux(runner);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('still not found on PATH');
    });
  });

  describe('Linux', () => {
    it('installs via apt-get as root without sudo', async () => {
      const { runner, calls } = linuxHost();
      const result = await installTmux(runner);
      expect(result).toMatchObject({ ok: true, method: 'apt-get', version: '3.4' });
      expect(calls).toContain('env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux');
      expect(calls.some(c => c.startsWith('sudo'))).toBe(false);
    });

    it('prefixes sudo -n for a non-root user with passwordless sudo', async () => {
      const { runner, calls } = linuxHost({ uid: '501', sudoOk: true });
      const result = await installTmux(runner);
      expect(result.ok).toBe(true);
      expect(calls).toContain('sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux');
    });

    it('fails with a copy-pastable manual command when sudo needs a password', async () => {
      const { runner, calls } = linuxHost({ uid: '501', sudoOk: false });
      const result = await installTmux(runner);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('passwordless sudo is unavailable');
      expect(result.message).toContain('sudo apt-get install -y tmux');
      expect(calls.some(c => c.includes('apt-get install'))).toBe(false);
    });

    it('fails when no supported package manager exists', async () => {
      const { runner } = linuxHost({ managers: [] });
      const result = await installTmux(runner);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('no supported package manager');
    });

    it('falls through the package manager probe order (dnf after apt-get)', async () => {
      const { runner, calls } = linuxHost({ managers: ['dnf'] });
      const result = await installTmux(runner);
      expect(result).toMatchObject({ ok: true, method: 'dnf' });
      expect(calls).toContain('command -v apt-get');
      expect(calls).toContain('dnf install -y tmux');
    });

    it('uses the pacman non-interactive flag', async () => {
      const { runner, calls } = linuxHost({ managers: ['pacman'] });
      const result = await installTmux(runner);
      expect(result.ok).toBe(true);
      expect(calls).toContain('pacman -S --noconfirm tmux');
    });

    it('retries an apt-get install once after refreshing the index', async () => {
      const { runner, calls } = linuxHost({ failFirstInstall: true });
      const result = await installTmux(runner);
      expect(result.ok).toBe(true);
      expect(calls).toContain('apt-get update');
      expect(calls.filter(c => c.includes('apt-get install -y tmux'))).toHaveLength(2);
    });

    it('does not retry non-apt package managers', async () => {
      const { runner, calls } = linuxHost({ managers: ['dnf'], installExit: 1 });
      const result = await installTmux(runner);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('dnf install failed (exit 1)');
      expect(calls.filter(c => c.includes('dnf install -y tmux'))).toHaveLength(1);
      expect(calls.some(c => c.includes('update'))).toBe(false);
    });
  });
});
