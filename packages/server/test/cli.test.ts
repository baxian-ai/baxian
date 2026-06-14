import { describe, it, expect } from 'vitest';
import {
  buildCli,
  readPackageVersion,
  readTtyDimensions,
  buildLocalAttachCommands,
  buildRemoteAttachSshArgs,
} from '../src/cli.js';

describe('CLI', () => {
  it('has expected commands', () => {
    const cli = buildCli();
    const names = cli.commands.map(c => c.name());
    expect(names).toContain('start');
    expect(names).toContain('status');
    expect(names).toContain('attach');
    expect(names).toContain('stop');
    expect(names).toContain('check');
  });
});

describe('readTtyDimensions', () => {
  it('only returns dims when both columns/rows are positive integers', () => {
    expect.soft(readTtyDimensions({ columns: 200, rows: 50 }), 'both positive').toEqual({ cols: 200, rows: 50 });
    expect.soft(readTtyDimensions({ rows: 50 }), 'columns missing').toBeNull();
    expect.soft(readTtyDimensions({ columns: 200 }), 'rows missing').toBeNull();
    expect.soft(readTtyDimensions({ columns: 0, rows: 50 }), 'zero columns').toBeNull();
    expect.soft(readTtyDimensions({ columns: 200, rows: 0 }), 'zero rows').toBeNull();
  });
});

describe('buildLocalAttachCommands', () => {
  it('restores tmux auto-size and enables focus-events, then attaches when dims given', () => {
    const cmds = buildLocalAttachCommands('dev-1', { cols: 180, rows: 48 });
    expect(cmds).toEqual([
      { kind: 'configure', file: 'tmux', args: ['set-option', '-t', '=dev-1:', 'window-size', 'latest'] },
      { kind: 'configure', file: 'tmux', args: ['set-option', '-g', 'focus-events', 'on'] },
      { kind: 'attach', file: 'tmux', args: ['-u', 'attach-session', '-t', '=dev-1'] },
    ]);
  });

  it('restores tmux auto-size even when dims is null (e.g. piped stdout, no tty)', () => {
    const cmds = buildLocalAttachCommands('dev-1', null);
    expect(cmds).toEqual([
      { kind: 'configure', file: 'tmux', args: ['set-option', '-t', '=dev-1:', 'window-size', 'latest'] },
      { kind: 'configure', file: 'tmux', args: ['set-option', '-g', 'focus-events', 'on'] },
      { kind: 'attach', file: 'tmux', args: ['-u', 'attach-session', '-t', '=dev-1'] },
    ]);
  });

  it('focus-events configure runs before attach and never as the attach step itself', () => {
    const cmds = buildLocalAttachCommands('dev-1', null);
    const focusIdx = cmds.findIndex(c => c.args.includes('focus-events'));
    const attachIdx = cmds.findIndex(c => c.kind === 'attach');
    expect(focusIdx).toBeGreaterThanOrEqual(0);
    expect(focusIdx).toBeLessThan(attachIdx);
    // configure steps run with ignored stdio/status, so a set-option failure cannot block attach.
    expect(cmds[focusIdx].kind).toBe('configure');
  });

  it('exact-match target prefix =agentId prevents prefix collisions', () => {
    const cmds = buildLocalAttachCommands('dev', null);
    expect(cmds[0].args).toContain('=dev:');
    expect(cmds[0].args).not.toContain('dev');
  });
});

describe('buildRemoteAttachSshArgs', () => {
  it('restores tmux auto-size before remote attach instead of relying on remote $COLUMNS/$LINES', () => {
    const args = buildRemoteAttachSshArgs({ hostname: 'hz1', user: 'baxian' }, 'dev-1', { cols: 180, rows: 48 });
    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toContain('tmux set-option');
    expect(remoteCmd).toContain('window-size');
    expect(remoteCmd).toContain('latest');
    expect(remoteCmd).not.toContain('tmux resize-window');
    expect(remoteCmd).not.toContain('-x 180');
    expect(remoteCmd).not.toContain('-y 48');
    expect(remoteCmd).not.toContain('$COLUMNS');
    expect(remoteCmd).not.toContain('$LINES');
    expect(remoteCmd).toContain('tmux -u attach-session');
  });

  it('emits the auto-size repair prefix when dims is null', () => {
    const args = buildRemoteAttachSshArgs({ hostname: 'hz1', user: 'baxian' }, 'dev-1', null);
    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).not.toContain('resize-window');
    expect(remoteCmd).toContain('window-size');
    expect(remoteCmd).toContain('latest');
    expect(remoteCmd).toContain('tmux -u attach-session');
  });

  it('quotes target session reference with exact-match prefix', () => {
    const args = buildRemoteAttachSshArgs({ hostname: 'hz1', user: 'baxian' }, 'dev-1', { cols: 100, rows: 30 });
    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toContain("'=dev-1'");
  });

  it('passes ssh flags (ConnectTimeout + -t + --) and leaves auth to ssh defaults (no BatchMode / password-only)', () => {
    const args = buildRemoteAttachSshArgs({ hostname: 'hz1', user: 'baxian' }, 'dev-1', null);
    expect(args).toContain('ConnectTimeout=10');
    expect(args).toContain('-t');
    const dashDashIdx = args.indexOf('--');
    const targetIdx = args.indexOf('baxian@hz1');
    expect(dashDashIdx).toBeGreaterThanOrEqual(0);
    expect(targetIdx).toBe(dashDashIdx + 1);
    // Interactive attach must not force key-only (BatchMode) or password-only auth.
    expect(args).not.toContain('BatchMode=yes');
    expect(args.join(' ')).not.toContain('PreferredAuthentications=password');
  });

  it('does not force password-only auth for a registry host whose password is redacted (allows publickey)', () => {
    const args = buildRemoteAttachSshArgs(
      { id: 'box', hostname: 'hz1', user: 'baxian', port: 22, password: '***' },
      'dev-1',
      null,
    );
    expect(args.join(' ')).not.toContain('PreferredAuthentications=password');
    expect(args).not.toContain('BatchMode=yes');
    expect(args.join(' ')).not.toContain('***'); // redacted marker never reaches the ssh command
  });

  it('auto-size repair failure does not block attach (|| true keeps stale-session race recoverable)', () => {
    const args = buildRemoteAttachSshArgs({ hostname: 'hz1', user: 'baxian' }, 'dev-1', { cols: 200, rows: 50 });
    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toMatch(/set-option[^;]*window-size[^;]*latest[^;]*\|\| true;/);
  });

  it('enables focus-events before attach, guarded so a failure cannot block attach', () => {
    const args = buildRemoteAttachSshArgs({ hostname: 'hz1', user: 'baxian' }, 'dev-1', null);
    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toMatch(/set-option -g focus-events on[^;]*\|\| true;/);
    expect(remoteCmd.indexOf('focus-events')).toBeLessThan(remoteCmd.indexOf('attach-session'));
  });
});

describe('readPackageVersion', () => {
  it('returns a semver-shaped string from the sibling package.json', () => {
    // In monorepo dev mode this reads packages/server/package.json.
    // In published npm package layout (post pnpm pack) it would read baxian/package.json.
    // Both must produce a string `x.y.z`; never crash, never empty.
    const v = readPackageVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});
