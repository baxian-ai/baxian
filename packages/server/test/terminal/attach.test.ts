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
    expect(script).toContain("exec tmux -u attach-session -t '=dev-1'");
    expect(script).not.toContain('&&');
    expect(script).toMatch(/set-clipboard external 2>\/dev\/null \|\| true;/);
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
    expect(script.indexOf('focus-events')).toBeLessThan(script.indexOf('attach-session'));
    expect(script.indexOf('set-clipboard')).toBeLessThan(script.indexOf('attach-session'));
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
    const idxE = cmd.args.indexOf('-e');
    expect(idxE).toBeGreaterThanOrEqual(0);
    expect(cmd.args[idxE + 1]).toBe('none');
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
