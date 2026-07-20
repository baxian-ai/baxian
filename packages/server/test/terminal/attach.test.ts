import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { AgentConfig } from '../../src/shared/index.js';
import type { AttachExpectedRef } from '../../src/terminal/attach.js';
import { buildAttachInteractiveCommand, buildAttachProbeCommand } from '../../src/terminal/attach.js';

interface CommandResult {
  errorMessage: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface TmuxFixtureCleanup {
  env: NodeJS.ProcessEnv;
  expected?: AttachExpectedRef;
  releaseChannels: string[];
  socketRoot: string;
  tmuxFile: string;
}

interface TmuxFixture extends TmuxFixtureCleanup {
  expected: AttachExpectedRef;
}

function runCommand(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', env, timeout: 5_000 }, (error, stdout, stderr) => {
      resolve({
        errorMessage: error?.message ?? '',
        exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout,
        stderr,
      });
    });
  });
}

function commandDiagnostic(result: CommandResult): string {
  return result.stderr.trim() || result.errorMessage;
}

async function requireCommand(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand(file, args, env);
  if (result.exitCode !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed (${result.exitCode}): ${commandDiagnostic(result)}`);
  }
  return result.stdout.trim();
}

function tmuxAbsent(result: CommandResult): boolean {
  return result.exitCode === 1 && /no server running|No such file or directory/.test(commandDiagnostic(result));
}

function tmuxExitProbeUncertain(result: CommandResult): boolean {
  return result.exitCode === 1 && /server exited unexpectedly|lost server/i.test(commandDiagnostic(result));
}

async function removeSocketRoot(socketRoot: string): Promise<void> {
  let root;
  try {
    root = await lstat(socketRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`failed to inspect tmux socket root ${socketRoot}: ${String(error)}`);
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`refusing to clean unexpected tmux socket root: ${socketRoot}`);
  }
  try {
    await rm(socketRoot, { recursive: true });
  } catch (error) {
    throw new Error(`failed to remove tmux socket root ${socketRoot}: ${String(error)}`);
  }
}

async function waitForTmuxServerExit(
  fixture: TmuxFixtureCleanup,
  timeoutMs = 2_000,
  probeServer = () => runCommand(fixture.tmuxFile, ['list-sessions'], fixture.env),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let uncertainDiagnostic: string | undefined;
  while (Date.now() < deadline) {
    const probe = await probeServer();
    if (tmuxAbsent(probe)) {
      if (uncertainDiagnostic) {
        console.warn(
          `[attach.test] tmux exit confirmed absent at ${fixture.socketRoot} after uncertain probe: ` +
          uncertainDiagnostic,
        );
      }
      return true;
    }
    if (tmuxExitProbeUncertain(probe)) {
      uncertainDiagnostic = commandDiagnostic(probe);
    } else if (probe.exitCode !== 0) {
      throw new Error(
        `tmux cleanup probe failed for ${fixture.socketRoot} (${probe.exitCode}): ${commandDiagnostic(probe)}`,
      );
    } else if (uncertainDiagnostic) {
      console.warn(
        `[attach.test] tmux server confirmed live at ${fixture.socketRoot} after uncertain probe: ` +
        uncertainDiagnostic,
      );
      uncertainDiagnostic = undefined;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (uncertainDiagnostic) {
    throw new Error(
      `tmux cleanup probe remained uncertain for ${fixture.socketRoot}: ${uncertainDiagnostic}`,
    );
  }
  return false;
}

async function forceStopOwnedTmuxServer(fixture: TmuxFixtureCleanup): Promise<boolean> {
  if (!fixture.expected) return false;
  const { serverPid, serverStart, sessionId, claim } = fixture.expected;
  const identity = `${serverPid}|${serverStart}|${sessionId}|${claim}`;
  const condition = `#{==:#{pid}|#{start_time}|#{session_id}|#{@baxian-agent-id},${identity}}`;
  const stopped = await runCommand(fixture.tmuxFile, [
    'if-shell', '-F', '-t', `${sessionId}:`, condition, 'kill-server',
  ], fixture.env);
  const exited = await waitForTmuxServerExit(fixture);
  if (!exited && stopped.exitCode !== 0) {
    throw new Error(
      `guarded tmux cleanup failed for ${fixture.socketRoot} (${stopped.exitCode}): ${commandDiagnostic(stopped)}`,
    );
  }
  if (!exited) return false;
  console.warn(
    `[attach.test] guarded cleanup reconciled stalled tmux server ` +
    `${serverPid}/${serverStart}/${sessionId} at ${fixture.socketRoot}: ` +
    (stopped.exitCode === 0 ? 'kill-server completed' : commandDiagnostic(stopped)),
  );
  return true;
}

async function stopTmuxFixture(
  fixture: TmuxFixtureCleanup,
  removeRoot: boolean,
  gracefulTimeoutMs = 2_000,
): Promise<void> {
  const initialProbe = await runCommand(fixture.tmuxFile, ['list-sessions'], fixture.env);
  if (tmuxAbsent(initialProbe)) {
    if (removeRoot) await removeSocketRoot(fixture.socketRoot);
    return;
  }
  if (initialProbe.exitCode !== 0) {
    throw new Error(
      `tmux cleanup probe failed for ${fixture.socketRoot} (${initialProbe.exitCode}): ` +
      commandDiagnostic(initialProbe),
    );
  }
  const signals = await Promise.all(fixture.releaseChannels.map(channel =>
    runCommand(fixture.tmuxFile, ['wait-for', '-S', channel], fixture.env)));
  const stopped = await waitForTmuxServerExit(fixture, gracefulTimeoutMs) ||
    await forceStopOwnedTmuxServer(fixture);
  if (!stopped) {
    const diagnostics = signals.map(commandDiagnostic).filter(Boolean).join('; ');
    throw new Error(
      `isolated tmux server at ${fixture.socketRoot} did not exit after release signals: ${diagnostics}`,
    );
  }
  if (removeRoot) await removeSocketRoot(fixture.socketRoot);
}

async function releaseTmuxFixture(
  fixture: TmuxFixtureCleanup,
  gracefulTimeoutMs = 2_000,
): Promise<void> {
  await stopTmuxFixture(fixture, true, gracefulTimeoutMs);
}

async function releaseTmuxSession(
  fixture: TmuxFixture,
  releaseChannel: string,
  sessionId: string,
): Promise<void> {
  const signal = await runCommand(fixture.tmuxFile, ['wait-for', '-S', releaseChannel], fixture.env);
  if (signal.exitCode !== 0) {
    throw new Error(
      `tmux release signal failed for ${sessionId} (${signal.exitCode}): ${commandDiagnostic(signal)}`,
    );
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const probe = await runCommand(fixture.tmuxFile, ['has-session', '-t', sessionId], fixture.env);
    if (probe.exitCode === 1 && !tmuxAbsent(probe)) {
      fixture.releaseChannels = fixture.releaseChannels.filter(channel => channel !== releaseChannel);
      return;
    }
    if (tmuxAbsent(probe)) {
      throw new Error(`tmux server exited while releasing session ${sessionId}: ${commandDiagnostic(probe)}`);
    }
    if (probe.exitCode !== 0) {
      throw new Error(
        `tmux release probe failed for ${sessionId} (${probe.exitCode}): ${commandDiagnostic(probe)}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`tmux session ${sessionId} did not exit after release signal ${releaseChannel}`);
}

async function startClaimedSession(
  tmuxFile: string,
  env: NodeJS.ProcessEnv,
  sessionName: string,
  releaseChannel: string,
): Promise<AttachExpectedRef> {
  const identity = await requireCommand(tmuxFile, [
    '-f', '/dev/null',
    'new-session', '-dP', '-F', '#{pid}|#{start_time}|#{session_id}',
    '-s', sessionName,
    `tmux wait-for ${releaseChannel}`,
  ], env);
  const [serverPid, serverStart, sessionId] = identity.split('|');
  if (!serverPid || !serverStart || !sessionId) {
    throw new Error(`invalid tmux identity: ${identity}`);
  }
  await requireCommand(tmuxFile, [
    'set-option', '-t', `${sessionId}:`, '@baxian-agent-id', sessionName,
  ], env);
  return { serverPid, serverStart, sessionId, claim: sessionName };
}

async function createTmuxFixture(tmuxFile = 'tmux'): Promise<TmuxFixture> {
  await requireCommand(tmuxFile, ['-V'], process.env);
  const nonce = randomUUID();
  const sessionName = `baxian-attach-${nonce}`;
  const releaseChannel = `baxian-attach-release-${nonce}`;
  const socketRoot = await mkdtemp(join(await realpath(tmpdir()), 'baxian-attach-test-'));
  const env = { ...process.env, TMUX_TMPDIR: socketRoot };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const cleanupRef: TmuxFixtureCleanup = {
    env,
    releaseChannels: [releaseChannel],
    socketRoot,
    tmuxFile,
  };

  try {
    cleanupRef.expected = await startClaimedSession(tmuxFile, env, sessionName, releaseChannel);
    return cleanupRef as TmuxFixture;
  } catch (error) {
    try {
      await releaseTmuxFixture(cleanupRef);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `tmux fixture setup and cleanup both failed for ${socketRoot}`,
      );
    }
    throw error;
  }
}

async function replaceTmuxSession(fixture: TmuxFixture): Promise<{
  stale: AttachExpectedRef;
  successor: AttachExpectedRef;
}> {
  const stale = fixture.expected;
  const staleChannel = fixture.releaseChannels[0];
  if (!staleChannel) throw new Error(`missing release channel for tmux session ${stale.sessionId}`);
  const keeperName = `baxian-attach-keeper-${randomUUID()}`;
  const keeperChannel = `baxian-attach-keeper-release-${randomUUID()}`;
  fixture.releaseChannels.push(keeperChannel);
  await startClaimedSession(fixture.tmuxFile, fixture.env, keeperName, keeperChannel);
  await releaseTmuxSession(fixture, staleChannel, stale.sessionId);

  const successorChannel = `baxian-attach-successor-release-${randomUUID()}`;
  fixture.releaseChannels.push(successorChannel);
  const successor = await startClaimedSession(
    fixture.tmuxFile,
    fixture.env,
    stale.claim,
    successorChannel,
  );
  fixture.expected = successor;
  return { stale, successor };
}

async function restartTmuxFixture(fixture: TmuxFixture): Promise<{
  stale: AttachExpectedRef;
  successor: AttachExpectedRef;
}> {
  const stale = fixture.expected;
  await stopTmuxFixture(fixture, false);
  const successorChannel = `baxian-attach-restart-release-${randomUUID()}`;
  fixture.releaseChannels = [successorChannel];
  const successor = await startClaimedSession(
    fixture.tmuxFile,
    fixture.env,
    stale.claim,
    successorChannel,
  );
  fixture.expected = successor;
  return { stale, successor };
}

function generationGuardScript(expected: AttachExpectedRef): string {
  const command = buildAttachInteractiveCommand(
    { id: expected.claim, runtime: 'codex', role: 'dev', mode: 'local' } as AgentConfig,
    undefined,
    expected,
  );
  const attachIndex = command.args[1].indexOf('exec tmux -u attach-session');
  if (attachIndex < 0) throw new Error('generated attach command is missing exec tmux');
  return `${command.args[1].slice(0, attachIndex)}printf BX_GUARD_PASSED`;
}

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
      expect(script).toMatch(/display-message -p -t '\$1:' '#\{pid\}\|#\{start_time\}\|#\{session_id\}\|#\{@baxian-agent-id\}'/);
      expect(script).not.toContain('-F');
      expect(script).toContain("= '4242|1700000000|$1|dev-1'");
      expect(script).toContain('BX_ATTACH_GENERATION_MISMATCH');
      expect(script).toContain('exit 47');
      expect(script).toContain("exec tmux -u attach-session -t '$1'");
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
      expect(remoteCmd).toContain('$1:');
      expect(remoteCmd).not.toContain('=dev-1');
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

describe('generation guard with real tmux target semantics', () => {
  it('requires a fresh absence proof after tmux reports an uncertain server exit', async () => {
    const fixture: TmuxFixtureCleanup = {
      env: {},
      releaseChannels: [],
      socketRoot: '/tmp/baxian-attach-test-reconcile',
      tmuxFile: 'tmux',
    };
    const uncertain = { errorMessage: '', exitCode: 1, stdout: '', stderr: 'server exited unexpectedly' };
    const absent = { errorMessage: '', exitCode: 1, stdout: '', stderr: 'no server running' };
    const probes: CommandResult[] = [uncertain, absent];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(waitForTmuxServerExit(
        fixture,
        100,
        async () => probes.shift() ?? absent,
      )).resolves.toBe(true);
      expect(probes).toEqual([]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('confirmed absent'));
    } finally {
      warning.mockRestore();
    }
  });

  it('fails closed when every tmux exit probe remains uncertain', async () => {
    const fixture: TmuxFixtureCleanup = {
      env: {},
      releaseChannels: [],
      socketRoot: '/tmp/baxian-attach-test-uncertain',
      tmuxFile: 'tmux',
    };
    const uncertain = { errorMessage: '', exitCode: 1, stdout: '', stderr: 'server exited unexpectedly' };
    await expect(waitForTmuxServerExit(fixture, 25, async () => uncertain)).rejects.toThrow(
      'tmux cleanup probe remained uncertain',
    );
  });

  it('still rejects a non-exit probe failure immediately', async () => {
    const fixture: TmuxFixtureCleanup = {
      env: {},
      releaseChannels: [],
      socketRoot: '/tmp/baxian-attach-test-failed-probe',
      tmuxFile: 'tmux',
    };
    const denied = { errorMessage: '', exitCode: 1, stdout: '', stderr: 'permission denied' };
    await expect(waitForTmuxServerExit(fixture, 100, async () => denied)).rejects.toThrow(
      'tmux cleanup probe failed',
    );
  });

  it('reports a missing tmux binary before allocating fixture resources', async () => {
    const missingTmux = `tmux-missing-${randomUUID()}`;
    await expect(createTmuxFixture(missingTmux)).rejects.toThrow(
      new RegExp(`spawn ${missingTmux} ENOENT`),
    );
  });

  it('attaches the guard to the pinned session and fails closed for every identity mismatch', async () => {
    const fixture = await createTmuxFixture();
    try {
      const accepted = await runCommand('sh', ['-c', generationGuardScript(fixture.expected)], fixture.env);
      expect(accepted).toEqual({ errorMessage: '', exitCode: 0, stdout: 'BX_GUARD_PASSED', stderr: '' });

      const mismatches: AttachExpectedRef[] = [
        { ...fixture.expected, serverPid: String(BigInt(fixture.expected.serverPid) + 1n) },
        { ...fixture.expected, serverStart: String(BigInt(fixture.expected.serverStart) + 1n) },
        { ...fixture.expected, sessionId: '$999999' },
        { ...fixture.expected, claim: `foreign-${randomUUID()}` },
      ];
      for (const expected of mismatches) {
        const rejected = await runCommand('sh', ['-c', generationGuardScript(expected)], fixture.env);
        expect(rejected.exitCode).toBe(47);
        expect(rejected.stderr).toContain('BX_ATTACH_GENERATION_MISMATCH');
        expect(rejected.stdout).toBe('');
      }
    } finally {
      await releaseTmuxFixture(fixture);
    }
  }, 10_000);

  it('rejects a stale ref after the same session name is recreated in the same server', async () => {
    const fixture = await createTmuxFixture();
    try {
      const { stale, successor } = await replaceTmuxSession(fixture);
      expect(successor.serverPid).toBe(stale.serverPid);
      expect(successor.serverStart).toBe(stale.serverStart);
      expect(successor.sessionId).not.toBe(stale.sessionId);
      expect(successor.claim).toBe(stale.claim);

      const accepted = await runCommand('sh', ['-c', generationGuardScript(successor)], fixture.env);
      expect(accepted).toMatchObject({ exitCode: 0, stdout: 'BX_GUARD_PASSED', stderr: '' });
      const rejected = await runCommand('sh', ['-c', generationGuardScript(stale)], fixture.env);
      expect(rejected.exitCode).toBe(47);
      expect(rejected.stderr).toContain('BX_ATTACH_GENERATION_MISMATCH');
    } finally {
      await releaseTmuxFixture(fixture);
    }
  }, 10_000);

  it('rejects a stale generation after server restart reuses the session ID and name', async () => {
    const fixture = await createTmuxFixture();
    try {
      const { stale, successor } = await restartTmuxFixture(fixture);
      expect(successor.serverPid).not.toBe(stale.serverPid);
      expect(successor.sessionId).toBe(stale.sessionId);
      expect(successor.claim).toBe(stale.claim);

      const accepted = await runCommand('sh', ['-c', generationGuardScript(successor)], fixture.env);
      expect(accepted).toMatchObject({ exitCode: 0, stdout: 'BX_GUARD_PASSED', stderr: '' });
      const rejected = await runCommand('sh', ['-c', generationGuardScript(stale)], fixture.env);
      expect(rejected.exitCode).toBe(47);
      expect(rejected.stderr).toContain('BX_ATTACH_GENERATION_MISMATCH');
    } finally {
      await releaseTmuxFixture(fixture);
    }
  }, 10_000);

  it('uses the generation-and-claim guard to clean a fixture after graceful release times out', async () => {
    const fixture = await createTmuxFixture();
    const releaseChannels = fixture.releaseChannels;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let released = false;
    try {
      fixture.releaseChannels = [`baxian-attach-unused-release-${randomUUID()}`];
      await releaseTmuxFixture(fixture, 25);
      released = true;
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(fixture.socketRoot));
      await expect(lstat(fixture.socketRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      warning.mockRestore();
      if (!released) {
        fixture.releaseChannels = releaseChannels;
        await releaseTmuxFixture(fixture);
      }
    }
  }, 10_000);
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
    expect(script).toContain("attach-session -f ignore-size -t '$5'");
    expect(script.indexOf('BX_ATTACH_GENERATION_MISMATCH')).toBeLessThan(script.indexOf('attach-session'));

    const remote = buildAttachInteractiveCommand(REMOTE, HOST, expected, { ignoreSize: true });
    const payload = remote.args.at(-1) as string;
    expect(payload).toContain('BX_ATTACH_GENERATION_MISMATCH');
    expect(payload).toContain('attach-session -f ignore-size -t');
  });
});
