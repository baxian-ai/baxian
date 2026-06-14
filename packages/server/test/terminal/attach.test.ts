import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '../../src/shared/index.js';
import { buildAttachInteractiveCommand } from '../../src/terminal/attach.js';

describe('buildAttachInteractiveCommand', () => {
  it('local: sh -c so a rejected option cannot abort the attach; execs the real attach-session, NO -r', () => {
    const cmd = buildAttachInteractiveCommand({
      id: 'dev-1',
      runtime: 'codex',
      role: 'dev',
      mode: 'local',
    } as AgentConfig);
    expect(cmd.file).toBe('sh');
    expect(cmd.args[0]).toBe('-c');
    const script = cmd.args[1];
    // exec hands the pty straight to the attach with the exact-match target.
    expect(script).toContain("exec tmux -u attach-session -t '=dev-1'");
    // Each option is a separate, error-tolerant command (`;` + `|| true`, never `&&`): a bad value
    // (e.g. a tmux too old for the `external` choice) cannot skip the attach that follows it.
    expect(script).not.toContain('&&');
    expect(script).toMatch(/set-clipboard external 2>\/dev\/null \|\| true;/);
    // A read-only attach (-r) would silently drop input.
    expect(script).not.toContain(' -r ');
  });

  it('local: focus-events and set-clipboard external are applied before the exec attach', () => {
    const cmd = buildAttachInteractiveCommand({
      id: 'dev-1',
      runtime: 'codex',
      role: 'dev',
      mode: 'local',
    } as AgentConfig);
    const script = cmd.args[1];
    // Server options must already be set when the client attaches (focus reporting; OSC 52 clipboard).
    expect(script.indexOf('focus-events')).toBeLessThan(script.indexOf('attach-session'));
    expect(script.indexOf('set-clipboard')).toBeLessThan(script.indexOf('attach-session'));
    // external (not on): tmux's own copies set the clipboard; raw OSC 52 from pane apps is ignored.
    expect(script).toContain('set-clipboard external');
  });

  it('remote: ssh -t -e none guards against SSH escape (~.) closing the hidden attach', () => {
    const cmd = buildAttachInteractiveCommand({
      id: 'qa-1',
      runtime: 'codex',
      role: 'qa',
      mode: 'remote',
    } as AgentConfig, { hostname: 'hz1', user: 'baxian' });
    expect(cmd.file).toBe('ssh');
    // `-e none` must be present: web users now write straight into ssh's PTY,
    // so a line-anchored `~.` would otherwise tear the SSH down.
    const idxE = cmd.args.indexOf('-e');
    expect(idxE).toBeGreaterThanOrEqual(0);
    expect(cmd.args[idxE + 1]).toBe('none');
    // Sanity: still requests a PTY and points at the right host/agent.
    expect(cmd.args).toContain('-t');
    expect(cmd.args).toContain('baxian@hz1');
    const remoteCmd = cmd.args[cmd.args.length - 1];
    expect(remoteCmd).toContain('tmux -u attach-session');
    expect(remoteCmd).toContain('=qa-1');
    expect(remoteCmd).not.toContain(' -r ');
  });

  it('remote: enables focus-events before attach, guarded so a failure cannot block attach', () => {
    const cmd = buildAttachInteractiveCommand({
      id: 'qa-1',
      runtime: 'codex',
      role: 'qa',
      mode: 'remote',
    } as AgentConfig, { hostname: 'hz1', user: 'baxian' });
    const remoteCmd = cmd.args[cmd.args.length - 1];
    expect(remoteCmd).toMatch(/set-option -g focus-events on[^;]*\|\| true;/);
    expect(remoteCmd.indexOf('focus-events')).toBeLessThan(remoteCmd.indexOf('attach-session'));
  });

  it('remote: enables set-clipboard external before attach, guarded so a failure cannot block attach', () => {
    const cmd = buildAttachInteractiveCommand({
      id: 'qa-1',
      runtime: 'codex',
      role: 'qa',
      mode: 'remote',
    } as AgentConfig, { hostname: 'hz1', user: 'baxian' });
    const remoteCmd = cmd.args[cmd.args.length - 1];
    expect(remoteCmd).toMatch(/set-option -g set-clipboard external[^;]*\|\| true;/);
    expect(remoteCmd.indexOf('set-clipboard')).toBeLessThan(remoteCmd.indexOf('attach-session'));
  });

  it('remote without explicit user: target is bare hostname', () => {
    const cmd = buildAttachInteractiveCommand({
      id: 'dev-2',
      runtime: 'codex',
      role: 'dev',
      mode: 'remote',
    } as AgentConfig, { hostname: 'hz1' });
    expect(cmd.args).toContain('hz1');
    expect(cmd.args).not.toContain('@hz1');
  });
});
