import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '../../src/shared/index.js';
import { buildAttachInteractiveCommand, buildAttachProbeCommand } from '../../src/terminal/attach.js';

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

  describe('generation guard (expected ref)', () => {
    const expected = { serverPid: '4242', serverStart: '1700000000', sessionId: '$1', claim: 'dev-1' };

    it('local: re-proves pid|start_time|session_id|claim right before exec, aborting on mismatch', () => {
      const cmd = buildAttachInteractiveCommand(
        { id: 'dev-1', runtime: 'codex', role: 'dev', mode: 'local' } as AgentConfig,
        undefined, expected,
      );
      const script = cmd.args[1];
      expect(script.indexOf('display-message')).toBeLessThan(script.indexOf('attach-session'));
      // display-message takes the format as its message arg (-p to print); it has NO -F flag (that would fail and abort every guarded attach).
      expect(script).toMatch(/display-message -p -t '=dev-1' '#\{pid\}\|#\{start_time\}\|#\{session_id\}\|#\{@baxian-agent-id\}'/);
      expect(script).not.toContain('-F');
      expect(script).toContain("= '4242|1700000000|$1|dev-1'");
      expect(script).toContain('BX_ATTACH_GENERATION_MISMATCH');
      expect(script).toContain('exit 47');
      expect(script).toContain("exec tmux -u attach-session -t '=dev-1'");
    });

    it('remote: the same guard runs inside the login-interactive wrapped command before attach', () => {
      const cmd = buildAttachInteractiveCommand(
        { id: 'dev-1', runtime: 'codex', role: 'dev', mode: 'remote' } as AgentConfig,
        { hostname: 'hz1', user: 'baxian' }, expected,
      );
      const remoteCmd = cmd.args[cmd.args.length - 1];
      expect(remoteCmd.indexOf('display-message')).toBeLessThan(remoteCmd.indexOf('attach-session'));
      // login-interactive wrapping escapes the inner quotes, but the identity content survives verbatim.
      expect(remoteCmd).toContain('4242|1700000000|$1|dev-1');
      expect(remoteCmd).toContain('BX_ATTACH_GENERATION_MISMATCH');
    });

    it('omitting expected keeps the legacy unguarded attach (no display-message probe)', () => {
      const cmd = buildAttachInteractiveCommand(
        { id: 'dev-1', runtime: 'codex', role: 'dev', mode: 'local' } as AgentConfig,
      );
      expect(cmd.args[1]).not.toContain('display-message');
      expect(cmd.args[1]).not.toContain('BX_ATTACH_GENERATION_MISMATCH');
    });
  });
});

describe('attach capability probe + ignore-size flag', () => {
  const LOCAL: AgentConfig = { id: 'dev-1', runtime: 'codex', role: 'dev', mode: 'local' } as AgentConfig;
  const REMOTE: AgentConfig = { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'remote' } as AgentConfig;
  const HOST = { name: 'h1', address: '10.0.0.5', user: 'ops' } as never;

  it('local probe runs tmux -V in the same sh -c context as the interactive attach', () => {
    const probe = buildAttachProbeCommand(LOCAL);
    const attach = buildAttachInteractiveCommand(LOCAL);
    expect(probe.file).toBe(attach.file);
    expect(probe.args[0]).toBe('-c');
    expect(probe.args[1]).toBe('exec tmux -V');
  });

  it('remote probe rides the same ssh + login-interactive wrapper as the interactive attach (PATH-skew guard)', () => {
    const probe = buildAttachProbeCommand(REMOTE, HOST);
    const attach = buildAttachInteractiveCommand(REMOTE, HOST);
    expect(probe.file).toBe('ssh');
    const probeSshOpts = probe.args.slice(0, probe.args.length - 1);
    const attachSshOpts = attach.args.slice(0, attach.args.length - 1);
    expect(probeSshOpts).toEqual(attachSshOpts);
    const probePayload = probe.args.at(-1) as string;
    const attachPayload = attach.args.at(-1) as string;
    expect(probePayload).toContain('tmux -V');
    // Same wrapper: strip the payload-specific tail and the shells must match.
    const wrapperOf = (payload: string) => payload.slice(0, payload.indexOf('tmux'));
    expect(wrapperOf(probePayload)).toBe(wrapperOf(attachPayload));
  });

  it('ignoreSize adds -f ignore-size to the attach-session invocation (local + remote)', () => {
    const local = buildAttachInteractiveCommand(LOCAL, undefined, undefined, { ignoreSize: true });
    expect(local.args[1]).toContain('attach-session -f ignore-size -t');
    const remote = buildAttachInteractiveCommand(REMOTE, HOST, undefined, { ignoreSize: true });
    expect(remote.args.at(-1)).toContain('attach-session -f ignore-size -t');
  });

  it('without ignoreSize the attach command is unchanged (pre-3.2 / unknown capability)', () => {
    const local = buildAttachInteractiveCommand(LOCAL, undefined, undefined, { ignoreSize: false });
    expect(local.args[1]).toContain('attach-session -t');
    expect(local.args[1]).not.toContain('ignore-size');
    const bare = buildAttachInteractiveCommand(LOCAL);
    expect(bare.args[1]).toBe(local.args[1]);
  });

  it('generation guard and ignore-size flag COMPOSE: guard runs before an ignore-size attach (local + remote)', () => {
    const expected = { serverPid: '42', serverStart: '1700000000', sessionId: '$5', claim: 'dev-1' };
    const local = buildAttachInteractiveCommand(LOCAL, undefined, expected, { ignoreSize: true });
    const script = local.args[1];
    expect(script).toContain('BX_ATTACH_GENERATION_MISMATCH');
    expect(script).toContain("'42|1700000000|$5|dev-1'");
    expect(script).toContain('attach-session -f ignore-size -t');
    expect(script.indexOf('BX_ATTACH_GENERATION_MISMATCH')).toBeLessThan(script.indexOf('attach-session'));

    const remote = buildAttachInteractiveCommand(REMOTE, HOST, expected, { ignoreSize: true });
    const payload = remote.args.at(-1) as string;
    expect(payload).toContain('BX_ATTACH_GENERATION_MISMATCH');
    expect(payload).toContain('attach-session -f ignore-size -t');
  });
});
