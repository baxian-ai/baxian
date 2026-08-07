import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TmuxManager, TmuxOutcomeUnknownError, PaneGoneError, SessionAbsentError, tmuxQuote, classifyOwnerWriteCapability, contentArea, desiredTty, parseStatusLines, parseWindowGeometry, detectStartupDialog, detectRuntimeMenu, detectReplActiveBusy, detectRuntimePendingPrompt, detectRuntimeOverlay, hasActiveSpinner, hasActiveSpinnerInTail, hasRuntimeReadyView, hasRuntimeIdleComposerPrompt, hasOscTitleWorking, hasOscTitleIdle, runtimeBusyCheck } from '../../src/agent/tmux.js';
import type { PaneRef } from '../../src/agent/tmux.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';

type ExecMock = ReturnType<typeof vi.fn<(cmd: string) => Promise<ExecResult>>>;

function mockRunner(): CommandRunner & { exec: ExecMock } {
  return {
    exec: vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    }),
    writeFile: vi.fn<(p: string, c: Buffer | string) => Promise<void>>().mockResolvedValue(undefined),
    execWithStdin: vi.fn<(cmd: string, stdin: Buffer) => Promise<ExecResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    }),
  };
}

const lastCmd = (runner: { exec: ExecMock }): string => {
  const calls = runner.exec.mock.calls;
  return String(calls[calls.length - 1][0]);
};

const PANE: PaneRef = {
  session: { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' },
  paneId: '%7',
  claim: 'dev-1',
};

const okHeader = (value: string): string => `BX_PANE_OK${value}\n`;
const okBody = (content: string): string => `BX_PANE_OK\n${content}`;
const composeSnapStdout = (visible: string, history: string | number): string =>
  `BX_PANE_OK|${history}\n${visible}`;
const buildSnapshot = (visible: string, history: number): string =>
  `${visible}\n---history_size:${history}---`;

describe('TmuxManager', () => {
  let runner: ReturnType<typeof mockRunner>;
  let tmux: TmuxManager;

  beforeEach(() => {
    runner = mockRunner();
    tmux = new TmuxManager(runner);
  });

  const primeExec = (...stdouts: string[]): void => {
    for (const stdout of stdouts) {
      runner.exec.mockResolvedValueOnce({ stdout, stderr: '', exitCode: 0 });
    }
  };

  describe('createSession', () => {
    const REF_OUT = '4242|1700000000|$1\n';

    it('runs tmux new-session with raw session name (no exact-match prefix needed for new sessions)', async () => {
      primeExec(REF_OUT);
      await tmux.createSession('kk-dev-1', '/home/user/code');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('tmux new-session -d');
      expect(cmd).toContain("-s 'kk-dev-1'");
      expect(cmd).toContain("-c '/home/user/code'");
    });

    it('sets default pane size 200x50 via -x/-y', async () => {
      primeExec(REF_OUT);
      await tmux.createSession('kk-dev-1', '/home/user/code');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('-x 200');
      expect(cmd).toContain('-y 50');
    });

    it('injects literal PATH via tmux -e (no shell-side $PATH expansion → fish-safe)', async () => {
      primeExec(REF_OUT);
      await tmux.createSession('kk-dev-1', '/home/user/code');
      const cmd = lastCmd(runner);
      expect(cmd).toContain(
        "-e 'PATH=/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'",
      );
      expect(cmd).not.toContain('$PATH');
    });

    it('does NOT chain post-create options (those live in buildFreshSession for rollback safety)', async () => {
      primeExec(REF_OUT);
      await tmux.createSession('kk-dev-1', '/home/user/code');
      const cmd = lastCmd(runner);
      expect(cmd).not.toContain('set-option');
      expect(cmd).not.toContain('mouse');
      expect(cmd).not.toContain('allow-passthrough');
      expect(cmd).not.toContain('extended-keys');
    });

    it('throws when new-session fails (e.g. duplicate name)', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: '', stderr: 'duplicate session: kk-dev-1', exitCode: 1,
      });
      await expect(tmux.createSession('kk-dev-1', '/tmp')).rejects.toThrow(/duplicate session/);
    });
  });

  describe('setServerOption', () => {
    it('uses set-option -s (server scope, not -t session)', async () => {
      await tmux.setServerOption('extended-keys', 'on');
      const cmd = lastCmd(runner);
      expect(cmd).toBe("tmux set-option -s 'extended-keys' 'on'");
    });

    it('throws on non-zero exit', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: '', stderr: 'unknown option: extended-keys', exitCode: 1,
      });
      await expect(tmux.setServerOption('extended-keys', 'on')).rejects.toThrow(/unknown option/);
    });
  });

  describe('appendServerOptionIfMissing', () => {
    it('gates the append with grep -F so a value already in the list is left alone', async () => {
      await tmux.appendServerOptionIfMissing('terminal-features', 'xterm*:extkeys');
      const cmd = lastCmd(runner);
      expect(cmd).toContain("show-option -s -v 'terminal-features'");
      expect(cmd).toContain("grep -qF 'xterm*:extkeys'");
      expect(cmd).toContain("set-option -sa 'terminal-features' 'xterm*:extkeys'");
      expect(cmd).toContain('||');
    });

    it('throws on non-zero exit', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: '', stderr: 'tmux server not running', exitCode: 1,
      });
      await expect(
        tmux.appendServerOptionIfMissing('terminal-features', 'xterm*:extkeys'),
      ).rejects.toThrow(/tmux server not running/);
    });
  });

  describe('resizeWindowByRef', () => {
    const REF = { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' };

    it('rides the size change and the window-size pin on one claim-checked if-shell', async () => {
      primeExec('');
      await tmux.resizeWindowByRef(REF, 'dev-1', 100, 30);
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '$7'");
      expect(cmd).toContain('resize-window');
      expect(cmd).toContain('-x 100');
      expect(cmd).toContain('-y 30');
      expect(cmd).toContain('window-size latest');
      expect(cmd).toContain('#{==:#{@baxian-agent-id},dev-1}');
      expect(cmd).toContain('BX_TARGET_GONE');
    });

    it('throws PaneGoneError instead of resizing a mismatched session', async () => {
      primeExec('BX_TARGET_GONE\n');
      await expect(tmux.resizeWindowByRef(REF, 'dev-1', 80, 24)).rejects.toThrow(PaneGoneError);
    });

    it('throws PaneGoneError when the server is gone', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'no server running on /tmp/x', exitCode: 1 });
      await expect(tmux.resizeWindowByRef(REF, 'dev-1', 80, 24)).rejects.toThrow(PaneGoneError);
    });

    it('rejects non-positive or non-integer dimensions before any exec', async () => {
      await expect(tmux.resizeWindowByRef(REF, 'dev-1', 0, 24)).rejects.toThrow(/invalid dimensions/);
      await expect(tmux.resizeWindowByRef(REF, 'dev-1', 80, 24.5)).rejects.toThrow(/invalid dimensions/);
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('throws on other non-zero exits', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'window not found', exitCode: 1 });
      await expect(tmux.resizeWindowByRef(REF, 'dev-1', 80, 24)).rejects.toThrow(/window not found/);
    });
  });

  describe('probeTmuxVersion', () => {
    it.each([
      ['tmux 3.6a\n', { major: 3, minor: 6 }, '"tmux 3.6a"'],
      ['tmux 3.4\n', { major: 3, minor: 4 }, '"tmux 3.4" (no suffix)'],
      ['tmux next-3.5\n', { major: 3, minor: 5 }, '"tmux next-3.5" (development build)'],
    ])('parses %j → %j', async (stdout, expected) => {
      primeExec(stdout);
      expect(await TmuxManager.probeTmuxVersion(runner)).toEqual(expected);
    });

    it('throws on non-zero exit', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'tmux: command not found', exitCode: 127 });
      await expect(TmuxManager.probeTmuxVersion(runner)).rejects.toThrow(/tmux -V failed/);
    });

    it('throws on unparseable output (no version pattern)', async () => {
      primeExec('something unexpected\n');
      await expect(TmuxManager.probeTmuxVersion(runner)).rejects.toThrow(/unparseable/);
    });
  });

  describe('killSessionRef', () => {
    const REF = { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' };

    it('kills through a server-generation-checked if-shell, never a bare name', async () => {
      primeExec('');
      expect(await tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' })).toBe('killed');
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '$7' -F");
      expect(cmd).toContain('#{&&:#{==:#{pid},4242},#{==:#{start_time},1700000000}}');
      expect(cmd).toContain(`kill-session -t '\\''$7'\\'`);
      expect(cmd).toContain('BX_KILL_REFUSED');
    });

    it('reports refused when the by-id recheck proves the session still exists', async () => {
      primeExec('BX_KILL_REFUSED\n', '');
      expect(await tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' })).toBe('refused');
      expect(lastCmd(runner)).toBe("tmux has-session -t '$7'");
    });

    it('skips the recheck when the kill succeeds (single tmux call)', async () => {
      primeExec('');
      expect(await tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' })).toBe('killed');
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('reclassifies REFUSED as absent when tmux >= 3.6 silently accepted a missing target', async () => {
      primeExec('BX_KILL_REFUSED\n');
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: "can't find session: $7", exitCode: 1 });
      expect(await tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' })).toBe('absent');
    });

    it('reclassifies REFUSED as absent when the server died before the recheck', async () => {
      primeExec('BX_KILL_REFUSED\n');
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'no server running on /tmp/tmux-501/default', exitCode: 1 });
      expect(await tmux.killSessionRef(REF, { kind: 'unclaimed' })).toBe('absent');
    });

    it('throws outcome-unknown when the recheck fails transiently (never fabricates refused or absent)', async () => {
      primeExec('BX_KILL_REFUSED\n');
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'ssh: connect: connection refused', exitCode: 255 });
      await expect(tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' }))
        .rejects.toBeInstanceOf(TmuxOutcomeUnknownError);
    });

    it('throws a hard error when the recheck fails in an unrecognized way', async () => {
      primeExec('BX_KILL_REFUSED\n');
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'server exited unexpectedly', exitCode: 1 });
      await expect(tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' }))
        .rejects.toThrow(/recheck unexpected exit 1/);
    });

    it('treats a vanished session as absent (idempotent)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: "can't find session: $7", exitCode: 1 });
      expect(await tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' })).toBe('absent');
    });

    it('treats a dead server as absent', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'no server running on /tmp/tmux-501/default', exitCode: 1 });
      expect(await tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' })).toBe('absent');
    });

    it('throws on an ssh-layer failure instead of guessing', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'ssh: connect: connection refused', exitCode: 255 });
      await expect(tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' }))
        .rejects.toBeInstanceOf(TmuxOutcomeUnknownError);
    });

    it('refuses to run with a malformed ref (defense against credential corruption)', async () => {
      await expect(tmux.killSessionRef({ sessionId: 'dev', serverPid: '1', serverStart: '2' }, { kind: 'unclaimed' }))
        .rejects.toThrow(/malformed session ref/);
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('refuses to run with a claim that could alter tmux filter syntax', async () => {
      await expect(tmux.killSessionRef(REF, { kind: 'equals', claim: 'a,b}' }))
        .rejects.toThrow(/unsupported characters/);
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('unclaimed adds the claim-empty condition, a session target, and the refused marker', async () => {
      primeExec('');
      expect(await tmux.killSessionRef(REF, { kind: 'unclaimed' })).toBe('killed');
      const cmd = lastCmd(runner);
      expect(cmd).toContain("-t '$7'");
      expect(cmd).toContain('#{==:#{@baxian-agent-id},}');
      expect(cmd).toContain('#{&&:#{&&:#{==:#{pid},4242},#{==:#{start_time},1700000000}}');
      expect(cmd).toContain('BX_KILL_REFUSED');
    });

    it('unclaimed reports refused without killing when the server declines', async () => {
      primeExec('BX_KILL_REFUSED\n', '');
      expect(await tmux.killSessionRef(REF, { kind: 'unclaimed' })).toBe('refused');
    });

    it('equals binds the kill to the exact claim (no empty-claim escape hatch)', async () => {
      primeExec('');
      expect(await tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' })).toBe('killed');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('#{==:#{@baxian-agent-id},dev-1}');
      expect(cmd).not.toContain('#{||:');
    });

    it('emptyOr accepts an unclaimed session or the exact claim', async () => {
      primeExec('');
      expect(await tmux.killSessionRef(REF, { kind: 'emptyOr', claim: 'dev-1' })).toBe('killed');
      expect(lastCmd(runner)).toContain('#{||:#{==:#{@baxian-agent-id},},#{==:#{@baxian-agent-id},dev-1}}');
    });
  });

  describe('createSession credential', () => {
    it('returns the generation-bound ref printed atomically by -PF', async () => {
      primeExec('4242|1700000000|$12\n');
      expect(await tmux.createSession('dev', '/wt')).toEqual({
        serverPid: '4242', serverStart: '1700000000', sessionId: '$12',
      });
      expect(lastCmd(runner)).toContain("-PF '#{pid}|#{start_time}|#{session_id}'");
    });

    it('injects the creation nonce atomically via -e', async () => {
      primeExec('4242|1700000000|$12\n');
      await tmux.createSession('dev', '/wt');
      expect(lastCmd(runner)).toMatch(/-e 'BAXIAN_CREATION_NONCE=[0-9a-f-]{36}'/);
    });

    it('reconciles an uncertain outcome by matching the nonce and returns the surviving ref', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 });
      primeExec('4242|1700000000|$12|\n');
      runner.exec.mockImplementationOnce(async () => {
        const createCmd = String(runner.exec.mock.calls[0][0]);
        const nonce = /BAXIAN_CREATION_NONCE=([0-9a-f-]{36})/.exec(createCmd);
        return { stdout: `BAXIAN_CREATION_NONCE=${nonce?.[1] ?? 'missing'}\n`, stderr: '', exitCode: 0 };
      });
      expect(await tmux.createSession('dev', '/wt')).toEqual({
        serverPid: '4242', serverStart: '1700000000', sessionId: '$12',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('reconciled after uncertain outcome'));
      warn.mockRestore();
    });

    it('fails cleanly when reconcile finds no surviving session', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'Connection reset by peer', exitCode: 255 });
      primeExec('');
      await expect(tmux.createSession('dev', '/wt')).rejects.toThrow(/Failed to create tmux session dev/);
    });

    it('reconciles after an exec-layer rejection too — a rejected client call may hide a live session', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      runner.exec.mockRejectedValueOnce(new Error('socket hang up'));
      primeExec('4242|1700000000|$12|\n');
      runner.exec.mockImplementationOnce(async () => {
        const createCmd = String(runner.exec.mock.calls[0][0]);
        const nonce = /BAXIAN_CREATION_NONCE=([0-9a-f-]{36})/.exec(createCmd);
        return { stdout: `BAXIAN_CREATION_NONCE=${nonce?.[1] ?? 'missing'}\n`, stderr: '', exitCode: 0 };
      });
      expect(await tmux.createSession('dev', '/wt')).toEqual({
        serverPid: '4242', serverStart: '1700000000', sessionId: '$12',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('reconciled after uncertain outcome'));
      warn.mockRestore();
    });

    it('refuses to touch a same-name session whose nonce does not match', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'Connection reset by peer', exitCode: 255 });
      primeExec('4242|1700000000|$12|\n');
      primeExec('BAXIAN_CREATION_NONCE=someone-elses-nonce\n');
      await expect(tmux.createSession('dev', '/wt')).rejects.toThrow(/not created by this call/);
    });

    it('fails closed instead of trusting an unparseable -PF ref on exit 0', async () => {
      primeExec('\n');
      primeExec('');
      await expect(tmux.createSession('dev', '/wt')).rejects.toThrow(/Failed to create tmux session dev/);
    });

    it('rejects session names that could alter tmux filter syntax', async () => {
      await expect(tmux.createSession('a,b}', '/wt')).rejects.toThrow(/unsupported characters/);
      expect(runner.exec).not.toHaveBeenCalled();
    });
  });

  describe('getSessionSnapshot', () => {
    it('returns ref and claim from one exact-name filtered round trip', async () => {
      primeExec('4242|1700000000|$3|dev\n');
      expect(await tmux.getSessionSnapshot('dev')).toEqual({
        ref: { serverPid: '4242', serverStart: '1700000000', sessionId: '$3' },
        claim: 'dev',
      });
      const cmd = lastCmd(runner);
      expect(cmd).toContain('tmux list-sessions -F');
      expect(cmd).toContain("'#{==:#{session_name},dev}'");
    });

    it('maps an unset claim option to null', async () => {
      primeExec('4242|1700000000|$3|\n');
      expect((await tmux.getSessionSnapshot('dev'))?.claim).toBeNull();
    });

    it('returns null when no session matches', async () => {
      primeExec('');
      expect(await tmux.getSessionSnapshot('dev')).toBeNull();
    });

    it('returns null when the server is not running', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'no server running on /tmp/tmux-501/default', exitCode: 1 });
      expect(await tmux.getSessionSnapshot('dev')).toBeNull();
    });

    it('throws on transport failure instead of reporting absence', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'ssh: connect: connection refused', exitCode: 255 });
      await expect(tmux.getSessionSnapshot('dev')).rejects.toBeInstanceOf(TmuxOutcomeUnknownError);
    });
  });

  describe('setSessionOptionsIfAlive', () => {
    const REF = { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' };

    it('batches all options into one identity-checked if-shell command (fresh-create batch, empty expectedClaim)', async () => {
      primeExec('');
      expect(await tmux.setSessionOptionsIfAlive(REF, [['@baxian-agent-id', 'dev'], ['mouse', 'on']], { expectedClaim: '' })).toBe('applied');
      expect(runner.exec).toHaveBeenCalledTimes(1);
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '$7'");
      expect(cmd).toContain('#{&&:#{&&:#{==:#{pid},4242},#{==:#{start_time},1700000000}},#{==:#{session_id},$7}}');
      expect(cmd).toContain('#{==:#{@baxian-agent-id},}');
      expect(cmd).toContain("set-option -t '\\''$7'\\'' @baxian-agent-id '\\''dev'\\''");
      expect(cmd).toContain("set-option -t '\\''$7'\\'' mouse '\\''on'\\''");
      expect(cmd).toContain('BX_TARGET_GONE');
    });

    it('binds a non-empty expectedClaim into the same server-side condition', async () => {
      primeExec('');
      expect(await tmux.setSessionOptionsIfAlive(REF, [['mouse', 'on']], { expectedClaim: 'dev-1' })).toBe('applied');
      expect(lastCmd(runner)).toContain('#{==:#{@baxian-agent-id},dev-1}');
    });

    it('reports gone instead of configuring a fallback session', async () => {
      primeExec('BX_TARGET_GONE\n');
      expect(await tmux.setSessionOptionsIfAlive(REF, [['mouse', 'on']], { expectedClaim: 'dev-1' })).toBe('gone');
    });

    it('treats a dead server as gone', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'no server running on /tmp/x', exitCode: 1 });
      expect(await tmux.setSessionOptionsIfAlive(REF, [['mouse', 'on']], { expectedClaim: 'dev-1' })).toBe('gone');
    });

    it('rejects option values tmux quoting cannot hold (newline)', async () => {
      await expect(tmux.setSessionOptionsIfAlive(REF, [['@k', 'a\nb']], { expectedClaim: 'dev-1' })).rejects.toThrow(/unsupported characters/);
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('rejects an expectedClaim that could alter tmux filter syntax', async () => {
      await expect(tmux.setSessionOptionsIfAlive(REF, [['mouse', 'on']], { expectedClaim: 'a,b}' })).rejects.toThrow(/unsupported characters/);
      expect(runner.exec).not.toHaveBeenCalled();
    });
  });

  describe('getSinglePaneByRef', () => {
    const REF = { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' };

    it('resolves a claim-bound PaneRef through an exact generation+session+claim filter', async () => {
      primeExec('%3 zsh\n');
      expect(await tmux.getSinglePaneByRef(REF, 'dev-1')).toEqual({ session: REF, paneId: '%3', claim: 'dev-1' });
      const cmd = lastCmd(runner);
      expect(cmd).toContain('list-panes -a');
      expect(cmd).toContain('#{==:#{session_id},$7}');
      expect(cmd).toContain('#{==:#{pid},4242}');
      expect(cmd).toContain('#{==:#{@baxian-agent-id},dev-1}');
    });

    it('reports the session gone when nothing matches the filter', async () => {
      primeExec('');
      await expect(tmux.getSinglePaneByRef(REF, 'dev-1')).rejects.toThrow(/gone/);
    });

    it('refuses multi-pane sessions', async () => {
      primeExec('%1 zsh\n%2 zsh\n');
      await expect(tmux.getSinglePaneByRef(REF, 'dev-1')).rejects.toThrow(/expects exactly one/);
    });

    it('rejects a malformed claim before any exec', async () => {
      await expect(tmux.getSinglePaneByRef(REF, 'a,b}')).rejects.toThrow(/unsupported characters/);
      expect(runner.exec).not.toHaveBeenCalled();
    });
  });

  describe('hasCreationNonce', () => {
    it('detects the nonce env var on a half-created session', async () => {
      primeExec('BAXIAN_CREATION_NONCE=abc\n');
      expect(await tmux.hasCreationNonce('dev')).toBe(true);
    });

    it('returns false when the variable is unknown', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'unknown variable: BAXIAN_CREATION_NONCE', exitCode: 1 });
      expect(await tmux.hasCreationNonce('dev')).toBe(false);
    });

    it('throws on transport failure', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'ssh: connect: connection refused', exitCode: 255 });
      await expect(tmux.hasCreationNonce('dev')).rejects.toBeInstanceOf(TmuxOutcomeUnknownError);
    });
  });

  describe('hasSession', () => {
    it('returns true on exit 0 with exact target', async () => {
      primeExec('');
      expect(await tmux.hasSession('dev')).toBe(true);
      expect(lastCmd(runner)).toContain("-t '=dev'");
    });

    it.each([
      ['tmux "session not found" stderr', "can't find session: dev"],
      ['"no server running" stderr', 'no server running'],
      [
        'tmux server socket is missing (fresh user, no daemon ever started)',
        'error connecting to /tmp/tmux-1001/default (No such file or directory)',
      ],
    ])('returns false on %s', async (_label, stderr) => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr, exitCode: 1 });
      expect(await tmux.hasSession('dev')).toBe(false);
    });

    it.each([
      ['exit 255 (ssh layer) — does not silently report absence', 'ssh: timeout', 255, /outcome unknown/],
      ['unexpected exit (not absence-classified)', 'permission denied', 7, /unexpected exit 7/],
      ['exit=1 with empty stderr (do NOT silently treat as absent)', '', 1, /unexpected exit 1/],
      ['exit 1 with mixed absence + independent transient', "can't find session: dev\nconnection reset by peer", 1, /outcome unknown/],
    ])('throws on %s', async (_label, stderr, exitCode, pattern) => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr, exitCode });
      await expect(tmux.hasSession('dev')).rejects.toThrow(pattern);
    });

    it('types a transient has-session result as outcome unknown', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'ssh: timeout', exitCode: 255 });
      await expect(tmux.hasSession('dev')).rejects.toBeInstanceOf(TmuxOutcomeUnknownError);
    });
  });

  describe('displayMessage', () => {
    it('queries pane_current_command through the identity-guarded marker-first read', async () => {
      primeExec(okHeader('claude'));
      const out = await tmux.displayMessage(PANE, '#{pane_current_command}');
      expect(out).toBe('claude');
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '%7'");
      expect(cmd).toContain('display-message -p -t %7');
      expect(cmd).toContain('#{pane_current_command}');
      expect(cmd).toContain('BX_PANE_OK');
      expect(cmd).toContain('BX_TARGET_GONE');
      expect(cmd).toContain('#{==:#{@baxian-agent-id},dev-1}');
      expect(cmd).toContain('#{==:#{pane_id},%7}');
    });

    it('throws PaneGoneError when the identity condition fails server-side', async () => {
      primeExec('BX_TARGET_GONE\n');
      await expect(tmux.displayMessage(PANE, '#{pane_current_command}')).rejects.toThrow(PaneGoneError);
    });

    it('rejects formats that could break out of tmux quoting', async () => {
      await expect(tmux.displayMessage(PANE, "#{pane_title}'")).rejects.toThrow(/unsupported characters/);
      expect(runner.exec).not.toHaveBeenCalled();
    });
  });

  describe('getSessionOptionByRef', () => {
    const REF = { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' };

    it('reads the option through a claim-checked marker-first command', async () => {
      primeExec(okHeader('1.2.3'));
      expect(await tmux.getSessionOptionByRef(REF, 'dev-1', '@baxian-context-task-id')).toBe('1.2.3');
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '$7'");
      expect(cmd).toContain('#{==:#{@baxian-agent-id},dev-1}');
      expect(cmd).toContain('#{@baxian-context-task-id}');
      expect(cmd).toContain('BX_PANE_OK');
      expect(cmd).toContain('BX_TARGET_GONE');
    });

    it('maps an unset/empty option to null', async () => {
      primeExec(okHeader(''));
      expect(await tmux.getSessionOptionByRef(REF, 'dev-1', '@baxian-context-task-id')).toBeNull();
    });

    it('throws PaneGoneError when the identity condition fails', async () => {
      primeExec('BX_TARGET_GONE\n');
      await expect(tmux.getSessionOptionByRef(REF, 'dev-1', '@baxian-context-task-id')).rejects.toThrow(PaneGoneError);
    });

    it('throws PaneGoneError when the server is gone', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'no server running on /tmp/x', exitCode: 1 });
      await expect(tmux.getSessionOptionByRef(REF, 'dev-1', '@baxian-context-task-id')).rejects.toThrow(PaneGoneError);
    });
  });

  describe('sendKeysToPane / sendKeysLiteral (identity-guarded pane writes)', () => {
    it('sendKeysToPane wraps send-keys in an if-shell bound to generation+session+pane+claim', async () => {
      await tmux.sendKeysToPane(PANE, 'C-c');
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '%7'");
      expect(cmd).toContain('send-keys -t %7');
      expect(cmd).toContain("'C-c'");
      expect(cmd).toContain('#{==:#{@baxian-agent-id},dev-1}');
      expect(cmd).toContain('#{==:#{pane_id},%7}');
      expect(cmd).toContain('#{==:#{session_id},$1}');
      expect(cmd).toContain('#{==:#{pid},4242}');
      expect(cmd).toContain('BX_TARGET_GONE');
    });

    it('sendKeysToPane forwards multiple key tokens (e.g., text + Enter)', async () => {
      await tmux.sendKeysToPane(PANE, 'echo hi', 'Enter');
      const cmd = lastCmd(runner);
      expect(cmd).toContain("'echo hi'");
      expect(cmd).toContain("'Enter'");
    });

    it('sendKeysLiteral uses send-keys -l (literal mode, no key parsing)', async () => {
      await tmux.sendKeysLiteral(PANE, 'literal-text');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('send-keys -l -t %7');
      expect(cmd).toContain("'literal-text'");
      expect(cmd).toContain('BX_TARGET_GONE');
    });

    it('sendKeysToPane is a noop when keys are empty (no exec)', async () => {
      await tmux.sendKeysToPane(PANE);
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('throws PaneGoneError instead of typing into a recycled pane', async () => {
      primeExec('BX_TARGET_GONE\n');
      await expect(tmux.sendKeysToPane(PANE, 'Enter')).rejects.toThrow(PaneGoneError);
    });

    it('throws PaneGoneError when the session/server is gone', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: "can't find session: $1", exitCode: 1 });
      await expect(tmux.sendKeysToPane(PANE, 'Enter')).rejects.toThrow(PaneGoneError);
    });
  });

  describe('sendEnter', () => {
    it('sends the Enter key through the guarded pane write', async () => {
      await tmux.sendEnter(PANE);
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '%7'");
      expect(cmd).toContain('send-keys -t %7');
      expect(cmd).toContain("'Enter'");
      expect(cmd).toContain('BX_TARGET_GONE');
    });
  });

  describe('clearComposerDraft (dirty-then-C-c: safe on empty and drafted composers)', () => {
    it('injects a literal space before C-c so C-c always hits a non-empty composer', async () => {
      await tmux.clearComposerDraft(PANE);
      const cmds = runner.exec.mock.calls.map(c => String(c[0]));
      expect(cmds).toHaveLength(2);
      expect(cmds[0]).toContain('send-keys -l -t %7');
      expect(cmds[0]).toContain("' '");
      expect(cmds[1]).toContain('send-keys -t %7');
      expect(cmds[1]).toContain("'C-c'");
      expect(cmds[1]).not.toContain('send-keys -l');
    });

    it('propagates failure when the space injection fails (no blind C-c on unknown composer)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'no such pane', exitCode: 1 });
      await expect(tmux.clearComposerDraft(PANE)).rejects.toThrow(/guarded write/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('stops before C-c when the pane identity is gone', async () => {
      primeExec('BX_TARGET_GONE\n');
      await expect(tmux.clearComposerDraft(PANE)).rejects.toThrow(PaneGoneError);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('capturePaneById', () => {
    it('default flags: -p -J (no ANSI for v1 plain preview) inside the guarded read', async () => {
      primeExec(okBody('content\n'));
      expect(await tmux.capturePaneById(PANE)).toBe('content\n');
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '%7'");
      expect(cmd).toContain('capture-pane -p -J');
      expect(cmd).not.toMatch(/(^|\s)-e(\s|$)/);
      expect(cmd).toContain('-t %7');
      expect(cmd).toContain('BX_PANE_OK');
      expect(cmd).toContain('BX_TARGET_GONE');
    });

    it('opts.ansi=true adds -e (ANSI escape passthrough)', async () => {
      primeExec(okBody(''));
      await tmux.capturePaneById(PANE, { ansi: true });
      const cmd = lastCmd(runner);
      expect(cmd).toMatch(/(^|\s)-e(\s|$)/);
    });

    it('opts.scrollback>0 adds -S -<n>', async () => {
      primeExec(okBody(''));
      await tmux.capturePaneById(PANE, { scrollback: 2000 });
      const cmd = lastCmd(runner);
      expect(cmd).toContain('-S');
      expect(cmd).toContain('-2000');
    });

    it('throws PaneGoneError when the identity condition fails', async () => {
      primeExec('BX_TARGET_GONE\n');
      await expect(tmux.capturePaneById(PANE)).rejects.toThrow(PaneGoneError);
    });
  });

  describe('injectPrompt (probe-gated stdin load → claim-checked paste-or-self-clean)', () => {
    const stdinMock = (r: typeof runner): ExecMock =>
      (r as unknown as { execWithStdin: ExecMock }).execWithStdin;

    it('loads via probe-gated stdin (no openssl), then a separate guarded paste', async () => {
      await tmux.injectPrompt(PANE, 'hello world', 'dev-1');
      const stdin = stdinMock(runner);
      expect(stdin).toHaveBeenCalledTimes(1);
      const loadCmd = stdin.mock.calls[0][0] as string;
      const payload = stdin.mock.calls[0][1] as Buffer;
      expect(loadCmd).not.toContain('openssl');
      expect(loadCmd).toContain('tmux load-buffer');
      expect(loadCmd).toContain('[ "$(tmux display-message -p -t ');
      expect(payload.toString('utf8')).toBe('hello world');
      expect(runner.exec).toHaveBeenCalledTimes(1);
      const pasteCmd = lastCmd(runner);
      expect(pasteCmd).toContain("tmux if-shell -t '%7'");
      expect(pasteCmd).toContain('paste-buffer');
      expect(pasteCmd).toMatch(/-d -p -r/);
      expect(pasteCmd).toContain('delete-buffer');
      expect(pasteCmd).toContain('BX_TARGET_GONE');
      expect(pasteCmd).toMatch(/baxian-dev-1-[0-9a-f-]{36}/);
    });

    it('probe-gates the load: the five-field identity test precedes load-buffer in the load command', async () => {
      await tmux.injectPrompt(PANE, 'x', 'dev-1');
      const loadCmd = stdinMock(runner).mock.calls[0][0] as string;
      expect(loadCmd).toContain('#{pid}|#{start_time}|#{session_id}|#{pane_id}|#{@baxian-agent-id}');
      expect(loadCmd).toContain("'4242|1700000000|$1|%7|dev-1'");
      expect(loadCmd.indexOf('display-message')).toBeLessThan(loadCmd.indexOf('load-buffer'));
    });

    it('throws PaneGoneError when the identity probe fails before load (no buffer, no reconcile)', async () => {
      stdinMock(runner).mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      await expect(tmux.injectPrompt(PANE, 'x', 'dev-1')).rejects.toThrow(/before any buffer was created/);
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('throws PaneGoneError when the paste-time condition fails (buffer self-cleaned server-side)', async () => {
      primeExec('BX_TARGET_GONE\n');
      await expect(tmux.injectPrompt(PANE, 'x', 'dev-1')).rejects.toThrow(PaneGoneError);
      expect(lastCmd(runner)).toContain('delete-buffer');
    });

    it('reconciles the loaded buffer by unique name when the pane vanishes AFTER load (exit 1 can\'t find pane)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: "can't find pane: %7", exitCode: 1 });
      primeExec('');
      await expect(tmux.injectPrompt(PANE, 'x', 'dev-1')).rejects.toThrow(PaneGoneError);
      expect(runner.exec).toHaveBeenCalledTimes(2);
      const deleteCmd = lastCmd(runner);
      expect(deleteCmd).toContain('tmux delete-buffer -b');
      expect(deleteCmd).toMatch(/baxian-dev-1-[0-9a-f-]{36}/);
      warn.mockRestore();
    });

    it('reconciles by name when the load outcome is unknown (exit 255)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stdinMock(runner).mockResolvedValueOnce({ stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 });
      primeExec('');
      await expect(tmux.injectPrompt(PANE, 'x', 'dev-1')).rejects.toThrow(/load outcome unknown/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
      expect(lastCmd(runner)).toContain('tmux delete-buffer -b');
      warn.mockRestore();
    });

    it('reconciles then rejects on a plain paste non-zero exit', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'paste boom', exitCode: 5 });
      primeExec('');
      await expect(tmux.injectPrompt(PANE, 'x', 'dev-1')).rejects.toThrow(/paste failed/);
      expect(lastCmd(runner)).toContain('tmux delete-buffer -b');
      warn.mockRestore();
    });

    it('accepts a prompt at exactly 80KB (boundary inside the cap)', async () => {
      const cap = 80 * 1024;
      const prompt = 'x'.repeat(cap);
      await expect(tmux.injectPrompt(PANE, prompt, 'dev-1')).resolves.toBeUndefined();
      expect(stdinMock(runner)).toHaveBeenCalledTimes(1);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('stagePromptBuffer loads via stdin (no openssl); pasteStagedBuffer pastes on the same named buffer', async () => {
      const { buf } = await tmux.stagePromptBuffer('%0', 'hello world', 'dev-1');
      expect(buf).toMatch(/^baxian-dev-1-[0-9a-f-]{36}$/);
      await tmux.pasteStagedBuffer('%0', buf);

      const stdin = stdinMock(runner);
      expect(stdin).toHaveBeenCalledTimes(1);
      const loadCmd = stdin.mock.calls[0][0] as string;
      const payload = stdin.mock.calls[0][1] as Buffer;
      expect(loadCmd).toContain('tmux load-buffer');
      expect(loadCmd).not.toContain('openssl');
      expect(loadCmd).not.toContain('paste-buffer');
      expect(loadCmd).toContain(buf);
      expect(payload.toString('utf8')).toBe('hello world');
      expect(runner.exec).toHaveBeenCalledTimes(1);
      const pasteCmd = String(runner.exec.mock.calls[0][0]);
      expect(pasteCmd).toContain('tmux paste-buffer');
      expect(pasteCmd).toContain(buf);
      expect(pasteCmd).toMatch(/-d -p -r/);
    });

    it('dropStagedBuffer deletes the staged buffer and surfaces failures', async () => {
      await tmux.dropStagedBuffer('baxian-dev-1-buf');
      expect(lastCmd(runner)).toContain("tmux delete-buffer -b 'baxian-dev-1-buf'");

      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'no buffer', exitCode: 1 });
      await expect(tmux.dropStagedBuffer('baxian-dev-1-buf')).rejects.toThrow(/no buffer/);
    });

    it('reconciles an unknown-outcome staging by retiring the buffer before rethrowing', async () => {
      stdinMock(runner).mockResolvedValueOnce({ stdout: '', stderr: 'connection reset', exitCode: 255 });

      await expect(tmux.stagePromptBuffer('%0', 'prompt', 'dev-1')).rejects.toThrow(/outcome unknown/);
      const cmds = runner.exec.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(cmds.some(cmd => cmd.includes('delete-buffer'))).toBe(true);
    });

    it('staging transport failure retires the possibly-created buffer before rethrowing', async () => {
      stdinMock(runner).mockRejectedValueOnce(new Error('ssh channel died'));

      await expect(tmux.stagePromptBuffer('%0', 'prompt', 'dev-1')).rejects.toThrow(/ssh channel died/);
      const cmds = runner.exec.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(cmds.some(cmd => cmd.includes('delete-buffer'))).toBe(true);
    });

    it('an unconfirmed cleanup is loud and keeps the buffer credential in the error', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stdinMock(runner).mockResolvedValueOnce({ stdout: '', stderr: 'connection reset', exitCode: 255 });
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('delete-buffer')) return { stdout: '', stderr: 'connection reset by peer', exitCode: 255 };
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const err = await tmux.stagePromptBuffer('%0', 'prompt', 'dev-1').then(
        () => { throw new Error('expected rejection'); },
        (e: unknown) => e as Error,
      );
      expect(err.message).toMatch(/outcome unknown/);
      const bufMatch = err.message.match(/staged buffer (baxian-dev-1-[0-9a-f-]{36}) may persist remotely/);
      expect(bufMatch).not.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(bufMatch![1]!));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('exit 255'));
      warn.mockRestore();
    });

    it('a definite missing-buffer answer counts as retired, not a cleanup failure', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      stdinMock(runner).mockResolvedValue({ stdout: '', stderr: 'connection reset', exitCode: 255 });
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('delete-buffer')) return { stdout: '', stderr: 'no buffer baxian-dev-1-x', exitCode: 1 };
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      await expect(tmux.stagePromptBuffer('%0', 'prompt', 'dev-1')).rejects.toThrow(/outcome unknown/);
      await expect(tmux.stagePromptBuffer('%0', 'prompt', 'dev-1')).rejects.not.toThrow(/may persist remotely/);
      expect(warn).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(expect.stringContaining('retired staged buffer'));
      warn.mockRestore();
      info.mockRestore();
    });

    it('a transport-thrown load with an unprobeable cleanup logs the surviving credential', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stdinMock(runner).mockRejectedValueOnce(new Error('ssh channel died'));
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('delete-buffer')) return { stdout: '', stderr: '', exitCode: 255 };
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      await expect(tmux.stagePromptBuffer('%0', 'prompt', 'dev-1')).rejects.toThrow(/ssh channel died/);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/buffer baxian-dev-1-[0-9a-f-]{36} may persist remotely.*exit 255/),
      );
      warn.mockRestore();
    });

    it('a definite staging failure does not probe the buffer', async () => {
      stdinMock(runner).mockResolvedValueOnce({ stdout: '', stderr: 'bad option', exitCode: 1 });

      await expect(tmux.stagePromptBuffer('%0', 'prompt', 'dev-1')).rejects.toThrow(/bad option/);
      const cmds = runner.exec.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(cmds.some(cmd => cmd.includes('delete-buffer'))).toBe(false);
    });

    it('stagePromptBuffer rejects an oversized prompt before issuing any tmux command', async () => {
      const prompt = 'x'.repeat(80 * 1024 + 1);
      await expect(tmux.stagePromptBuffer('%0', prompt, 'dev-1')).rejects.toThrow(/prompt too large/);
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('rejects a prompt over 80KB before issuing any tmux command (deterministic error)', async () => {
      const cap = 80 * 1024;
      const prompt = 'x'.repeat(cap + 1);
      await expect(tmux.injectPrompt(PANE, prompt, 'dev-1')).rejects.toThrow(/prompt too large/);
      expect(runner.exec).not.toHaveBeenCalled();
    });
  });

  describe('capturePaneSnapshot', () => {
    it('runs the marker-first display-message + capture-pane in one guarded exec (atomic snapshot)', async () => {
      primeExec(composeSnapStdout('\x1b[32mready\x1b[0m\nline two\n', 42));
      const snap = await tmux.capturePaneSnapshot(PANE);
      expect(runner.exec).toHaveBeenCalledTimes(1);
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '%7'");
      expect(cmd).toContain('capture-pane -t %7 -e -p');
      expect(cmd).toContain('display-message -p -t %7');
      expect(cmd).toContain('#{history_size}');
      expect(cmd).toContain('BX_TARGET_GONE');
      expect(snap).toContain('ready');
      expect(snap).toContain('line two');
      expect(snap).not.toContain('\x1b[');
      expect(snap).toContain('---history_size:42---');
    });

    it('throws when the shell command exits non-zero', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'pane gone', exitCode: 2 });
      await expect(tmux.capturePaneSnapshot(PANE)).rejects.toThrow(/guarded read.*pane gone/);
    });

    it('throws PaneGoneError when the ok marker is missing (identity condition failed)', async () => {
      primeExec('visible only\n42\n');
      await expect(tmux.capturePaneSnapshot(PANE)).rejects.toThrow(PaneGoneError);
    });
  });

  describe('waitSubmitAck (ack = a fresh idle→busy transition only)', () => {
    const buildBaseline = buildSnapshot;
    let captureFrames: string[];
    let titleFrames: string[];
    let paneTitle: string;
    beforeEach(() => {
      captureFrames = [];
      titleFrames = [];
      paneTitle = '';
      runner.exec.mockImplementation(async () => ({
        stdout: captureFrames.shift() ?? composeSnapStdout('idle composer\n', 0),
        stderr: '',
        exitCode: 0,
      }));
      vi.spyOn(tmux, 'readPaneTitle').mockImplementation(async () => titleFrames.shift() ?? paneTitle);
    });
    const primeSnapshot = (visible: string, history: number): void => {
      captureFrames.push(composeSnapStdout(visible, history));
    };
    const primeTitle = (title: string): void => {
      titleFrames.push(title);
    };

    it('acks on an idle→busy transition (runtime starts working after submit)', async () => {
      const baseline = buildBaseline('idle composer\n', 0);
      primeSnapshot('idle composer\n', 0);
      primeSnapshot('working\n  esc to interrupt\n', 0);
      await expect(tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 1500, intervalMs: 50 }))
        .resolves.toBeUndefined();
    });

    it('acks via the OSC-title working spinner when in-pane content stays unrecognized-as-busy (narrow/wrapped pane)', async () => {
      const baseline = buildBaseline('› Run /review\n  gpt-5.5 xhigh · ~/repo\n', 0);
      primeTitle('~/repo');
      primeTitle('⠹ Reviewing');
      await expect(tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 1500, intervalMs: 50 }))
        .resolves.toBeUndefined();
    });

    it('rejects (busy baseline) when the pane is ALREADY working at entry — a spinner refresh is not a fresh ack', async () => {
      const baseline = buildBaseline('› Run /review\n  gpt-5.5 xhigh · ~/repo\n', 0);
      primeTitle('⠹ Reviewing');
      primeTitle('⠸ Reviewing');
      await expect(tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 200, intervalMs: 50 }))
        .rejects.toThrow(/pane already busy at baseline/);
    });

    it('honors a caller-provided PRE-Enter baseline title: a title already working on the first post-submit read still acks', async () => {
      const baseline = buildBaseline('› Run /review\n  gpt-5.5 xhigh · ~/repo\n', 0);
      primeTitle('⠹ Reviewing');
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 1500, intervalMs: 50, baselineTitle: '~/repo' }),
      ).resolves.toBeUndefined();
    });

    it('does NOT ack on scrollback growth alone when the runtime never goes busy (uncommitted redraw)', async () => {
      const baseline = buildBaseline('composer still open\n', 5);
      let h = 5;
      runner.exec.mockImplementation(async () => ({ stdout: composeSnapStdout('composer still open\n', ++h), stderr: '', exitCode: 0 }));
      await expect(tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 200, intervalMs: 50 }))
        .rejects.toThrow(/runtime ack timeout/);
    });

    it('busy baseline is non-ackable: no observable idle→busy transition (pasted prompt text looks busy)', async () => {
      const baseline = buildBaseline('do X\n  esc to interrupt\n', 3);
      let n = 0;
      runner.exec.mockImplementation(async () => ({ stdout: composeSnapStdout(`do X\n  esc to interrupt\n[Image #1] frame ${n++}\n`, 3), stderr: '', exitCode: 0 }));
      await expect(tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 200, intervalMs: 50 }))
        .rejects.toThrow(/runtime ack timeout/);
    });

    it('codex: stale esc-to-interrupt above → prompt is NOT busy baseline (position-aware)', async () => {
      const baseline = buildBaseline('Working on it…\n  esc to interrupt\n→ baxian git:(main)\n', 0);
      primeSnapshot('· Thinking… (2s)\n→ baxian git:(main)\n', 0);
      await expect(tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 1500, intervalMs: 50 }))
        .resolves.toBeUndefined();
    });

    it('codex: pasted prompt containing "Working (8s)" is NOT busy baseline', async () => {
      const baseline = buildBaseline('→ baxian git:(main)\nPlease explain this log:\nWorking (8s)\n', 0);
      primeSnapshot('· Thinking… (2s)\n  esc to interrupt\n', 0);
      await expect(tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 1500, intervalMs: 50 }))
        .resolves.toBeUndefined();
    });

    it('codex: full-screen spinner high on viewport acks after Enter', async () => {
      const baseline = buildBaseline('→ baxian git:(main)\nidle prompt text\n', 0);
      const lines = ['· Thinking… (2s)', ...Array(12).fill(''), '→ baxian git:(main)'].join('\n') + '\n';
      primeSnapshot(lines, 0);
      await expect(tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 1500, intervalMs: 50 }))
        .resolves.toBeUndefined();
    });

    it('throws "runtime ack timeout" when the pane stays idle (swallowed Enter)', async () => {
      const baseline = buildBaseline('idle composer\n', 0);
      runner.exec.mockResolvedValue({ stdout: composeSnapStdout('idle composer\n', 0), stderr: '', exitCode: 0 });
      await expect(tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 200, intervalMs: 50 }))
        .rejects.toThrow(/runtime ack timeout/);
    });

    it('re-sends Enter while the pane stays idle and acks once the resend submits', async () => {
      const baseline = buildBaseline('idle composer\n', 0);
      let submitted = false;
      runner.exec.mockImplementation(async () => ({
        stdout: composeSnapStdout(submitted ? 'working\n  esc to interrupt\n' : 'idle composer\n', 0),
        stderr: '',
        exitCode: 0,
      }));
      const resend = vi.fn(async () => { submitted = true; });
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 2000, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).resolves.toBeUndefined();
      expect(resend).toHaveBeenCalled();
    });

    it('re-sends Enter for a long multi-line pasted prompt held in the composer (no message left unsent)', async () => {
      const longComposer = Array.from({ length: 40 }, (_, i) => `wrapped prompt line ${i} ......................`).join('\n') + '\n';
      const baseline = buildBaseline(longComposer, 0);
      let submitted = false;
      runner.exec.mockImplementation(async () => ({
        stdout: composeSnapStdout(submitted ? 'working\n  esc to interrupt\n' : longComposer, 0),
        stderr: '',
        exitCode: 0,
      }));
      const resend = vi.fn(async () => { submitted = true; });
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 2000, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).resolves.toBeUndefined();
      expect(resend).toHaveBeenCalled();
    });

    it('re-sends Enter after the composer diverged from baseline but is still an idle composer', async () => {
      const baseline = buildBaseline('idle composer\n', 0);
      let submitted = false;
      runner.exec.mockImplementation(async () => ({
        stdout: composeSnapStdout(submitted ? 'working\n  esc to interrupt\n' : 'idle composer\n\n', 0),
        stderr: '',
        exitCode: 0,
      }));
      const resend = vi.fn(async () => { submitted = true; });
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 2000, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).resolves.toBeUndefined();
      expect(resend).toHaveBeenCalled();
    });

    it('does NOT re-send Enter while a Codex completion popup is open (Enter would insert, not submit)', async () => {
      const baseline = buildBaseline('› Review the PR\n  phase: review\n', 0);
      runner.exec.mockResolvedValue({
        stdout: composeSnapStdout('› Review the PR\n  phase: review\n\n  Press enter to insert or esc to close\n', 0),
        stderr: '',
        exitCode: 0,
      });
      const resend = vi.fn(async () => undefined);
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 250, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).rejects.toThrow(/runtime ack timeout/);
      expect(resend).not.toHaveBeenCalled();
    });

    it('re-sends Enter when the prompt body quotes the popup footer but the status line is still below it', async () => {
      const held = '› Review the PR\n  note: Press enter to insert or esc to close\n\n  gpt-5.5 xhigh · ~/repo\n';
      const baseline = buildBaseline(held, 0);
      let submitted = false;
      runner.exec.mockImplementation(async () => ({
        stdout: composeSnapStdout(submitted ? '· Thinking… (2s)\n' : held, 0),
        stderr: '',
        exitCode: 0,
      }));
      const resend = vi.fn(async () => { submitted = true; });
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 2000, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).resolves.toBeUndefined();
      expect(resend).toHaveBeenCalled();
    });

    it('does NOT re-send Enter when opencode opens a permission prompt (Enter would hit Allow once)', async () => {
      const baseline = buildBaseline('┃  Build auto · Zen\n', 0);
      runner.exec.mockResolvedValue({
        stdout: composeSnapStdout('△ Permission required\n  Allow once   Reject\n  ctrl+p commands\n', 0),
        stderr: '',
        exitCode: 0,
      });
      const resend = vi.fn(async () => undefined);
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'opencode', { timeoutMs: 250, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).rejects.toThrow(/runtime ack timeout/);
      expect(resend).not.toHaveBeenCalled();
    });

    it('does NOT re-send Enter when qodercli opens a confirmation prompt', async () => {
      const baseline = buildBaseline('*   Type your message or @path\n', 0);
      runner.exec.mockResolvedValue({
        stdout: composeSnapStdout('Permission Required\nAllow this command to run?\n  Type your message or @path\n', 0),
        stderr: '',
        exitCode: 0,
      });
      const resend = vi.fn(async () => undefined);
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'qodercli', { timeoutMs: 250, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).rejects.toThrow(/runtime ack timeout/);
      expect(resend).not.toHaveBeenCalled();
    });

    it('does NOT re-send Enter when a non-yolo claude-code bash permission prompt is up (real capture)', async () => {
      const baseline = buildBaseline('❯ \n', 0);
      runner.exec.mockResolvedValue({
        stdout: composeSnapStdout(`${CC_NONYOLO_BASH_PERMISSION}\n`, 0),
        stderr: '',
        exitCode: 0,
      });
      const resend = vi.fn(async () => undefined);
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 250, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).rejects.toThrow(/runtime ack timeout/);
      expect(resend).not.toHaveBeenCalled();
    });

    it('does NOT re-send Enter when a non-yolo codex escalation prompt is up (real capture)', async () => {
      const baseline = buildBaseline('› \n\n  gpt-5.5 xhigh · /w\n', 0);
      runner.exec.mockResolvedValue({
        stdout: composeSnapStdout(`${CODEX_NONYOLO_ESCALATION}\n`, 0),
        stderr: '',
        exitCode: 0,
      });
      const resend = vi.fn(async () => undefined);
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 250, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).rejects.toThrow(/runtime ack timeout/);
      expect(resend).not.toHaveBeenCalled();
    });

    it('re-sends Enter when the prompt body quotes a menu footer but the composer is held below it', async () => {
      const held = '› $baxian-task\n  describe a menu: Enter to select · Esc to cancel\n'
        + Array.from({ length: 20 }, (_, i) => `  detail line ${i}`).join('\n')
        + '\n\n  gpt-5.5 xhigh · ~/repo\n';
      const baseline = buildBaseline(held, 0);
      let submitted = false;
      runner.exec.mockImplementation(async () => ({
        stdout: composeSnapStdout(submitted ? '· Thinking… (2s)\n' : held, 0),
        stderr: '',
        exitCode: 0,
      }));
      const resend = vi.fn(async () => { submitted = true; });
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 2000, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).resolves.toBeUndefined();
      expect(resend).toHaveBeenCalled();
    });

    it('detects a Codex completion popup whose footer a narrow pane wrapped across two rows', async () => {
      const baseline = buildBaseline('› Review the PR\n  phase: review\n', 0);
      runner.exec.mockResolvedValue({
        stdout: composeSnapStdout('› Review the PR\n  Build Web Apps [Plugin]\n\n  Press enter to insert or esc\n  to close\n', 0),
        stderr: '',
        exitCode: 0,
      });
      const resend = vi.fn(async () => undefined);
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 250, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).rejects.toThrow(/runtime ack timeout/);
      expect(resend).not.toHaveBeenCalled();
    });

    it('does NOT re-send Enter once the pane leaves the composer for a menu — detect-only policy', async () => {
      const baseline = buildBaseline('idle composer\n', 0);
      runner.exec.mockResolvedValue({
        stdout: composeSnapStdout('Pick one\nEnter to select · Esc to cancel\n', 0),
        stderr: '',
        exitCode: 0,
      });
      const resend = vi.fn(async () => undefined);
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 250, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).rejects.toThrow(/runtime ack timeout/);
      expect(resend).not.toHaveBeenCalled();
    });
  });

  describe('captureSettledSnapshot (best-effort pre-Enter settle)', () => {
    const primeSnapshot = (visible: string, history: number): void => {
      primeExec(composeSnapStdout(visible, history));
    };

    it('returns the snapshot once two consecutive captures are identical', async () => {
      primeSnapshot('attaching\n', 0);
      primeSnapshot('settled\n', 0);
      primeSnapshot('settled\n', 0);
      const snap = await tmux.captureSettledSnapshot(PANE, { timeoutMs: 2000, intervalMs: 10 });
      expect(snap).toBe(buildSnapshot('settled\n', 0));
    });

    it('keeps polling while the pane is still redrawing, then returns the settled snapshot', async () => {
      primeSnapshot('f1\n', 0);
      primeSnapshot('f2\n', 0);
      primeSnapshot('f3\n', 0);
      primeSnapshot('f3\n', 0);
      const snap = await tmux.captureSettledSnapshot(PANE, { timeoutMs: 2000, intervalMs: 10 });
      expect(snap).toBe(buildSnapshot('f3\n', 0));
      expect(runner.exec.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('returns the latest snapshot when the pane never settles within the timeout', async () => {
      let n = 0;
      runner.exec.mockImplementation(async () => ({
        stdout: composeSnapStdout(`frame ${n++}\n`, 0),
        stderr: '', exitCode: 0,
      }));
      const snap = await tmux.captureSettledSnapshot(PANE, { timeoutMs: 80, intervalMs: 20 });
      expect(snap).toMatch(/^frame \d+\n\n---history_size:0---$/);
      expect(runner.exec.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('floors a zero poll interval so it cannot busy-spin, and still settles', async () => {
      primeSnapshot('settled\n', 0);
      primeSnapshot('settled\n', 0);
      const snap = await tmux.captureSettledSnapshot(PANE, { timeoutMs: 2000, intervalMs: 0 });
      expect(snap).toBe(buildSnapshot('settled\n', 0));
    });
  });

  describe('handleTrustDialog', () => {
    it('detects the claude trust dialog and sends Enter', async () => {
      primeExec(okBody('Quick safety check\n❯ 1. Yes, I trust this folder\n'), '');
      const answered = await tmux.handleTrustDialog(PANE, 'claude-code', { timeoutMs: 1000, intervalMs: 50 });
      expect(answered).toBe(true);
      const sentKeys = runner.exec.mock.calls[1][0] as string;
      expect(sentKeys).toContain('send-keys');
      expect(sentKeys).toContain("'Enter'");
    });

    it('returns false (already past dialog) when ready anchor is already visible', async () => {
      primeExec(okBody('⏵⏵ bypass permissions on\n'), okHeader('2.1.129'), okBody('⏵⏵ bypass permissions on\n'));
      const answered = await tmux.handleTrustDialog(PANE, 'claude-code', { timeoutMs: 200, intervalMs: 50 });
      expect(answered).toBe(false);
    });

    it('returns false early for codex → prompt when runtime is running', async () => {
      primeExec(okBody('→ baxian git:(main)\n'), okHeader('codex'), okBody('→ baxian git:(main)\n'));
      const answered = await tmux.handleTrustDialog(PANE, 'codex', { timeoutMs: 200, intervalMs: 50 });
      expect(answered).toBe(false);
    });

    it('stale shell → on first capture does not early-exit when fresh capture shows dialog', async () => {
      primeExec(
        okBody('→ baxian git:(main)\n'),
        okHeader('codex'),
        okBody('Do you trust the contents of this folder?\n› 1. Yes, continue\n'),
        okBody('Do you trust the contents of this folder?\n› 1. Yes, continue\n'),
        '',
      );
      const answered = await tmux.handleTrustDialog(PANE, 'codex', { timeoutMs: 2000, intervalMs: 50 });
      expect(answered).toBe(true);
    });

    it('does not early-exit on shell → prompt before runtime starts, then handles trust dialog', async () => {
      primeExec(
        okBody('→ baxian git:(main)\n'),
        okHeader('zsh'),
        okBody('Do you trust the contents of this folder?\n› 1. Yes, continue\n'),
        '',
      );
      const answered = await tmux.handleTrustDialog(PANE, 'codex', { timeoutMs: 2000, intervalMs: 50 });
      expect(answered).toBe(true);
    });

    it('detects codex dialog text (different from claude phrasing)', async () => {
      primeExec(okBody('Do you trust the contents of this folder?\n› 1. Yes, continue\n'), '');
      const answered = await tmux.handleTrustDialog(PANE, 'codex', { timeoutMs: 1000, intervalMs: 50 });
      expect(answered).toBe(true);
    });
  });

  describe('waitReplReady (chrome anchor + pane_current_command double check)', () => {
    it.each([
      [
        'claude-code: anchor + version-string proc title both required',
        '2.1.129\n', '⏵⏵ bypass permissions on (shift+tab to cycle)\n', 'claude-code' as const,
      ],
      [
        'claude-code: macOS tmux reports binary file name "claude.exe" — must satisfy procTitle',
        'claude.exe\n', '⏵⏵ bypass permissions on (shift+tab to cycle)\n', 'claude-code' as const,
      ],
      [
        'claude-code: accepts a small-pane idle composer when the footer ready anchor is hidden',
        'claude\n', '✻ Worked for 31s\n\n❯ \n', 'claude-code' as const,
      ],
      [
        'codex: accepts pane_current_command=node when the YOLO banner is visible',
        'node\n', 'permissions: YOLO mode\n', 'codex' as const,
      ],
      [
        'codex: accepts the idle prompt when the YOLO banner has scrolled out of view',
        'node\n',
        '─ Worked for 11m 32s ─────────────────────────────\n\n' +
          '› Find and fix a bug in @filename\n\n' +
          '  gpt-5.5 xhigh · ~/.baxian/repos/baxian-ai/baxian\n',
        'codex' as const,
      ],
      [
        'codex: accepts a non-gpt model idle prompt when the YOLO banner has scrolled out of view',
        'node\n',
        '─ Worked for 4m 02s ─────────────────────────────\n\n' +
          '› Check current PR feedback\n\n' +
          '  o3 high · ~/.baxian/repos/baxian-ai/baxian\n',
        'codex' as const,
      ],
      [
        'codex: accepts the backtrack hint footer (Esc on an empty composer) as idle/ready',
        'node\n',
        '─ Worked for 1m 14s ─────────────────\n\n' +
          '› Use /skills to list available skills\n\n' +
          '  esc again to edit previous message\n',
        'codex' as const,
      ],
    ])('%s', async (_label, procTitle, anchor, runtimeKind) => {
      primeExec(okHeader(procTitle.trim()), okBody(anchor));
      await expect(
        tmux.waitReplReady(PANE, runtimeKind, { timeoutMs: 1000, intervalMs: 30 }),
      ).resolves.toBeUndefined();
    });

    it('codex: does not accept an idle-prompt-shaped snippet while output continues after it', async () => {
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('pane_current_command')) {
          return { stdout: okHeader('node'), stderr: '', exitCode: 0 };
        }
        return {
          stdout: okBody(
            'Running generated regression tests\n\n' +
            '› Find and fix a bug in @filename\n\n' +
            '  gpt-5.5 xhigh · ~/.baxian/repos/baxian-ai/baxian\n\n' +
            'Still working on the request...\n',
          ),
          stderr: '',
          exitCode: 0,
        };
      });
      await expect(
        tmux.waitReplReady(PANE, 'codex', { timeoutMs: 120, intervalMs: 30 }),
      ).rejects.toThrow(/repl not ready/);
    });

    it('keeps polling when only the proc title matches (anchor still missing)', async () => {
      primeExec(okHeader('node'), okBody('still booting\n'), okHeader('node'), okBody('permissions: YOLO mode\n'));
      await expect(tmux.waitReplReady(PANE, 'codex', { timeoutMs: 2000, intervalMs: 30 })).resolves.toBeUndefined();
      expect(runner.exec.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('failFastOnShell:true aborts immediately when proc_current_command is a shell', async () => {
      primeExec(okHeader('zsh'));
      await expect(
        tmux.waitReplReady(PANE, 'claude-code', {
          timeoutMs: 5000, intervalMs: 30, failFastOnShell: true,
        }),
      ).rejects.toThrow(/failFastOnShell/);
    });

    it.each([
      ['throws on overall timeout when anchor never appears', 'codex' as const],
      ['claude-code: pane_current_command=node never satisfies claude (node belongs to codex only)', 'claude-code' as const],
    ])('%s', async (_label, runtimeKind) => {
      runner.exec.mockResolvedValue({ stdout: okHeader('node'), stderr: '', exitCode: 0 });
      await expect(
        tmux.waitReplReady(PANE, runtimeKind, { timeoutMs: 200, intervalMs: 50 }),
      ).rejects.toThrow(/repl not ready/);
    });

    it.each([
      ['default scrollback is 0 (visible-only) so a stale anchor in scrollback cannot satisfy ready', undefined, /-S 0/],
      ['opts.scrollback override still works for callers that want history (e.g., trust dialog)', 50, /-S -50/],
    ])('%s', async (_label, scrollback, pattern) => {
      primeExec(okHeader('codex'), okBody('permissions: YOLO mode\n'));
      await tmux.waitReplReady(PANE, 'codex', { timeoutMs: 1000, intervalMs: 30, scrollback });
      const captureCmd = runner.exec.mock.calls[1][0] as string;
      expect(captureCmd).toMatch(pattern);
    });

    describe('titleIdleFastPath (width-independent OSC title idle signal)', () => {
      const NARROW_IDLE_SCREEN =
        '合并门），合并动作留给你。\n' +
        '你合并后我再做本地清理（删\n' +
        'feat/spec-human-approval\n' +
        '分支、切回 main），或者你直\n' +
        '接说一声我来跑 gh pr\n' +
        'merge。\n' +
        '\n' +
        '✻ Churned for 56s\n';

      function mockPaneState(procTitle: string, screen: string, title: string): void {
        runner.exec.mockImplementation(async (cmd: string) => {
          if (cmd.includes('pane_current_command')) return { stdout: okHeader(procTitle), stderr: '', exitCode: 0 };
          if (cmd.includes('pane_title')) return { stdout: okHeader(title), stderr: '', exitCode: 0 };
          return { stdout: okBody(screen), stderr: '', exitCode: 0 };
        });
      }

      it('claude-code: narrow-pane reflowed idle screen (no anchor, no ❯) + "✳ " title → ready', async () => {
        mockPaneState('2.1.199', NARROW_IDLE_SCREEN, '✳ 分析 baxian 服务 DEV agent 不遵照指示问题');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('claude-code: same narrow screen + braille working title → keeps polling to timeout', async () => {
        mockPaneState('2.1.199', NARROW_IDLE_SCREEN, '⠹ 分析 baxian 服务 DEV agent 不遵照指示问题');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: "✳ " title does not shortcut an actively busy screen (esc to interrupt in tail)', async () => {
        mockPaneState('2.1.199', `${NARROW_IDLE_SCREEN}\nesc to interrupt\n`, '✳ 部署服务');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: "✳ " title does not shortcut a trust dialog', async () => {
        mockPaneState(
          'claude',
          'Quick safety check\nDo you trust the files in this folder?\n1. Yes, I trust this folder\n',
          '✳ Claude Code',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('fast path is opt-in: narrow idle screen + "✳ " title still times out without the flag', async () => {
        mockPaneState('2.1.199', NARROW_IDLE_SCREEN, '✳ 分析 baxian 服务 DEV agent 不遵照指示问题');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30 }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('codex: cwd-shaped title is not an idle signal (fast path is claude-code only)', async () => {
        mockPaneState('node', 'Still working on the request...\n', 'baxian');
        await expect(
          tmux.waitReplReady(PANE, 'codex', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('timeout error carries the last observed pane title for diagnosis', async () => {
        mockPaneState('2.1.199', NARROW_IDLE_SCREEN, '⠹ 分析 baxian');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/paneTitle=/);
      });

      it('claude-code: "✳ " title does not shortcut a visible permission prompt (do you want to proceed?)', async () => {
        mockPaneState(
          '2.1.199',
          'Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)\n',
          '✳ 清理构建产物',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: "✳ " title does not shortcut a narrow-wrapped select-option form (AskUserQuestion)', async () => {
        mockPaneState(
          '2.1.199',
          '选择合并策略：\n❯ 1. squash\n  2. rebase\n\nEnter to select ·\nEsc to cancel · Tab/arrow\nkeys to navigate\n',
          '✳ 等待合并策略选择',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: a pending-prompt phrase far above the tail does not veto an idle bottom screen', async () => {
        const history = '…上文引用：do you want to proceed? 的行为分析\n' + '正文\n'.repeat(16);
        mockPaneState('2.1.199', history + NARROW_IDLE_SCREEN, '✳ 分析报告');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('does not read the pane title while the screen is visibly busy (sync short-circuit first)', async () => {
        mockPaneState('2.1.199', `${NARROW_IDLE_SCREEN}\nesc to interrupt\n`, '✳ 部署服务');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
        const titleReads = runner.exec.mock.calls.filter(c => String(c[0]).includes('pane_title'));
        expect(titleReads.length).toBe(1);
      });

      it('timeout on a busy screen still reports the pane title via the failure-path fallback read', async () => {
        mockPaneState('2.1.199', `${NARROW_IDLE_SCREEN}\nesc to interrupt\n`, '⠹ 部署服务');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/paneTitle="⠹ 部署服务"/);
      });

      it('claude-code: "✳ " title does not shortcut a legacy offer prompt (would you like to + Yes option)', async () => {
        mockPaneState(
          '2.1.199',
          'Would you like to create the release tag now?\n❯ 1. Yes\n  2. No\n',
          '✳ 发布 1.2.37',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: "✳ " title does not shortcut the transcript viewer overlay', async () => {
        mockPaneState(
          '2.1.199',
          'transcript content line\n\nctrl+o to toggle · esc to close\n',
          '✳ 分析日志',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: an offer phrase in plain prose above an idle tail does not veto the fast path', async () => {
        mockPaneState(
          '2.1.199',
          `Would you like me to run gh pr merge?\n${NARROW_IDLE_SCREEN}`,
          '✳ 收尾合并',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('claude-code: a quoted permission phrase in a finished narrow reply does not veto the fast path', async () => {
        mockPaneState(
          '2.1.199',
          `检测覆盖了 Do you want to\nproceed? 这类权限提示。\n${NARROW_IDLE_SCREEN}`,
          '✳ 补充权限检测',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('claude-code: "✳ " title does not shortcut a narrow-wrapped confirm dialog (enter to confirm)', async () => {
        mockPaneState(
          '2.1.199',
          '确认重置会话？\nEnter to confirm ·\nEsc to cancel\n',
          '✳ 会话管理',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: a leftover composer draft below a quoted offer phrase does not veto the fast path', async () => {
        mockPaneState(
          '2.1.199',
          `表单文案 "would you like to" 已覆盖。\n${NARROW_IDLE_SCREEN}\n❯ run tests\n`,
          '✳ 跑测试收尾',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('claude-code: "✳ " title does not shortcut a permission prompt with bare unnumbered Yes options', async () => {
        mockPaneState(
          '2.1.199',
          'Do you want to proceed?\nYes\nNo\n',
          '✳ 执行构建脚本',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: "✳ " title does not shortcut a tall pending form whose offer sits above the tail window', async () => {
        mockPaneState(
          '2.1.199',
          '─'.repeat(40) + '\nWould you like to apply this plan?\n' + 'plan detail\n'.repeat(16) + '❯ 1. Yes\n  2. No\n',
          '✳ 制定实施计划',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });
    });
  });

  describe('readPaneTitle', () => {
    it('reads pane title via the guarded display-message #{pane_title}', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: okHeader('⠋ Reading file'), stderr: '', exitCode: 0,
      });
      const title = await tmux.readPaneTitle(PANE);
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '%7'");
      expect(cmd).toContain('#{pane_title}');
      expect(cmd).toContain('BX_PANE_OK');
      expect(title).toBe('⠋ Reading file');
    });

    it('returns empty string on failure', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: '', stderr: 'pane not found', exitCode: 1,
      });
      const title = await tmux.readPaneTitle(PANE);
      expect(title).toBe('');
    });

    it('returns empty string when the pane identity is gone (advisory signal, never authority)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'BX_TARGET_GONE\n', stderr: '', exitCode: 0 });
      expect(await tmux.readPaneTitle(PANE)).toBe('');
    });
  });

  describe('getPaneCurrentPath', () => {
    it('reads pane_current_path through the guarded read', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: okHeader('/home/user/wt'), stderr: '', exitCode: 0 });
      expect(await tmux.getPaneCurrentPath(PANE)).toBe('/home/user/wt');
      expect(lastCmd(runner)).toContain('#{pane_current_path}');
    });

    it('throws on an empty current path', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: okHeader(''), stderr: '', exitCode: 0 });
      await expect(tmux.getPaneCurrentPath(PANE)).rejects.toThrow(/empty current path/);
    });

    it('propagates PaneGoneError (unlike readPaneTitle it is not advisory)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'BX_TARGET_GONE\n', stderr: '', exitCode: 0 });
      await expect(tmux.getPaneCurrentPath(PANE)).rejects.toThrow(PaneGoneError);
    });
  });

  describe('classifyPaneForAdopt', () => {
    const composeProbeOut = (procTitle: string, capture: string): string =>
      `BX_PANE_OK${procTitle}\n${capture}`;

    it.each([
      [
        'returns "live-runtime" when proc title is the runtime even if ready anchor has scrolled off',
        'codex', '› ready for next prompt\n  gpt-5.5 xhigh · ~/.baxian/repos/...\n', 'codex' as const, 'live-runtime',
      ],
      [
        'returns "shell" when pane_current_command is a shell (zsh)',
        'zsh', '$ \n', 'codex' as const, 'shell',
      ],
      [
        'codex: returns "trust-dialog" only when BOTH question and option are visible',
        'codex', 'Do you trust the contents of this folder?\n› 1. Yes, continue\n', 'codex' as const, 'trust-dialog',
      ],
      [
        'does NOT classify as trust-dialog when only "Yes, continue" appears (e.g. agent output containing the phrase)',
        'codex', '› Sounds good. Yes, continue with this approach.\n  gpt-5.5 xhigh\n', 'codex' as const, 'live-runtime',
      ],
      [
        'returns "trust-dialog" only when BOTH halves are visible (claude)',
        'claude', 'Quick safety check\n❯ 1. Yes, I trust this folder\n', 'claude-code' as const, 'trust-dialog',
      ],
      [
        'claude-code: matches version-string proc title (claude rewrites argv0 to its semver)',
        '2.1.129', '', 'claude-code' as const, 'live-runtime',
      ],
      [
        'codex live runtime is not blocked by visible Codex startup text once ready anchor exists',
        'codex',
        ['Reviewing this diff:', 'Welcome to Codex', 'Sign in with ChatGPT', 'Provide your own API key', 'permissions: YOLO mode'].join('\n'),
        'codex' as const, 'live-runtime',
      ],
      [
        'claude live runtime is not blocked by visible Codex startup text',
        'claude',
        ['Reviewing this diff:', 'Welcome to Codex', 'Sign in with ChatGPT', 'Provide your own API key', '⏵⏵ bypass permissions on'].join('\n'),
        'claude-code' as const, 'live-runtime',
      ],
    ])('%s', async (_label, procTitle, capture, runtimeKind, expectedKind) => {
      primeExec(composeProbeOut(procTitle, capture));
      const result = await tmux.classifyPaneForAdopt(PANE, runtimeKind);
      expect(result).toEqual({ kind: expectedKind });
    });

    it('codex+node: also adopts as live-runtime — session claim check is the boundary, no in-pane process verification', async () => {
      primeExec(composeProbeOut('node', '› next prompt\n'));
      const result = await tmux.classifyPaneForAdopt(PANE, 'codex');
      expect(result).toEqual({ kind: 'live-runtime' });
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('returns "shell" for shells outside the original whitelist (dash/ksh/nu) — recovery path must not refuse them', async () => {
      for (const sh of ['dash', 'ksh', 'nu']) {
        primeExec(composeProbeOut(sh, '$ \n'));
        const result = await tmux.classifyPaneForAdopt(PANE, 'codex');
        expect(result).toEqual({ kind: 'shell' });
      }
    });

    it('returns "other" when foreground is a non-runtime non-shell process (vim) — does NOT trip dialog regex from buffer text', async () => {
      primeExec(composeProbeOut('vim', 'README excerpt: Press enter to continue.\n'));
      const result = await tmux.classifyPaneForAdopt(PANE, 'codex');
      expect(result.kind).toBe('other');
      if (result.kind === 'other') {
        expect(result.paneCurrentCommand).toBe('vim');
      }
    });

    it('returns "startup-dialog" only when procTitle matches runtime AND dialog text is visible', async () => {
      primeExec(composeProbeOut('codex', 'Update available\nPress enter to continue\n'));
      const result = await tmux.classifyPaneForAdopt(PANE, 'codex');
      expect(result.kind).toBe('startup-dialog');
      if (result.kind === 'startup-dialog') {
        expect(result.lastScreen).toContain('Press enter to continue');
      }
    });

    it('codex auth screen is a startup dialog only for codex runtime', async () => {
      primeExec(composeProbeOut(
          'codex',
          'Welcome to Codex\nSign in with ChatGPT\nProvide your own API key\n',
        ));
      const result = await tmux.classifyPaneForAdopt(PANE, 'codex');
      expect(result.kind).toBe('startup-dialog');
    });

    it('throws PaneGoneError when the ok marker is missing from the probe output', async () => {
      primeExec('codex\nincomplete output\n');
      await expect(tmux.classifyPaneForAdopt(PANE, 'codex')).rejects.toThrow(PaneGoneError);
    });
  });
});

describe('tmuxQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(tmuxQuote('hello')).toBe("'hello'");
  });

  it("escapes embedded single quotes via '\\'' splicing", () => {
    expect(tmuxQuote("a'b")).toBe("'a'\\''b'");
  });

  it('quotes the empty string as a pair of quotes', () => {
    expect(tmuxQuote('')).toBe("''");
  });

  it('round-trips values the old quoting rejected (spaces, unicode, tmux format braces)', () => {
    expect(tmuxQuote('✳ 分析 baxian')).toBe("'✳ 分析 baxian'");
    expect(tmuxQuote('#{pane_id}')).toBe("'#{pane_id}'");
  });

  it.each([
    ['newline', 'a\nb'],
    ['NUL', 'a\0b'],
  ])('throws on %s (cannot survive tmux command re-parsing)', (_label, value) => {
    expect(() => tmuxQuote(value)).toThrow(/unsupported characters/);
  });
});

describe('detectStartupDialog', () => {
  const POSITIVE: Array<[string, string]> = [
    [
      'old-style "Press enter to continue" (codex update prompt shape)',
      '✨ Update available! 0.128.0 -> 0.129.0\n› 1. Update now  2. Skip  3. Skip until next version\nPress enter to continue\n',
    ],
    ['"Press return to continue"', 'please Press return to continue.'],
    ['"Press any key to proceed"', 'Press any key to proceed'],
    [
      'modern claude menu: "Enter to confirm · Esc to cancel" (Bypass Permissions warning)',
      'WARNING: Claude Code running in Bypass Permissions mode\n...\n❯ 1. No, exit\n  2. Yes, I accept\nEnter to confirm · Esc to cancel\n',
    ],
    [
      'modern claude menu: trust-folder dialog (same Esc-cancel anchor)',
      'Accessing workspace: /home/baxian\nQuick safety check: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit\nEnter to confirm · Esc to cancel\n',
    ],
    [
      'claude status-bar "Auto-updating…" (Unicode ellipsis)',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ctrl+t to hide tasks                              Auto-updating…\n',
    ],
    ['"Auto-updating..." (ASCII triple-dot variant)', 'status bar: Auto-updating...\n'],
    ['bare "Auto-updating" at end of line', 'header line\nAuto-updating\nmore output'],
    ['"Auto-updating" with extra info after the word', 'status: Auto-updating to v2.1.87'],
    ['"Auto-updating (v0.x.y)"', 'Auto-updating (v0.x.y)'],
  ];

  const CODEX_POSITIVE: Array<[string, string]> = [
    [
      'codex auth menu observed on hz1 bootstrap',
      [
        '  Welcome to Codex, OpenAI\'s command-line coding agent',
        '',
        '  Sign in with ChatGPT to use Codex as part of your paid plan',
        '  or connect an API key for usage-based billing',
        '',
        '> 1. Sign in with ChatGPT',
        '  2. Sign in with Device Code',
        '  3. Provide your own API key',
      ].join('\n'),
    ],
    [
      'codex update-complete restart prompt observed on hz1 bootstrap',
      [
        'Updating Codex via `npm install -g @openai/codex`...',
        '',
        'changed 2 packages in 4s',
        '',
        'Update ran successfully! Please restart Codex.',
        '➜  baxian git:(fix/dashboard-fullwidth-and-preview-tail)',
      ].join('\n'),
    ],
  ];

  const NEGATIVE: Array<[string, string]> = [
    ['"Auto-updating" embedded mid-word (docs sentence)', 'Auto-updating-tutorial-link'],
    [
      'healthy ready REPL screen',
      'Welcome to Opus 4.7 xhigh!\n❯ Try "fix typecheck errors"\n⏵⏵ bypass permissions on (shift+tab to cycle)\n',
    ],
    ['unrelated startup logs (boot noise)', 'initialising plugins...\nloading config...'],
  ];

  const CODEX_NEGATIVE: Array<[string, string]> = [
    [
      'codex auth markers beyond bounded window',
      `Welcome to Codex${'x'.repeat(301)}Sign in with ChatGPT\nProvide your own API key`,
    ],
    [
      'codex update markers beyond bounded window',
      `Update ran successfully${'x'.repeat(201)}Please restart Codex`,
    ],
  ];

  it('matches every known startup-dialog signal', () => {
    for (const [name, screen] of POSITIVE) {
      expect.soft(detectStartupDialog(screen), name).toBe(true);
    }
  });

  it('matches Codex startup signals only for Codex runtime', () => {
    for (const [name, screen] of CODEX_POSITIVE) {
      expect.soft(detectStartupDialog(screen, 'codex'), name).toBe(true);
      expect.soft(detectStartupDialog(screen, 'claude-code'), name).toBe(false);
      expect.soft(detectStartupDialog(screen), name).toBe(false);
    }
  });

  it('does NOT match healthy / unrelated output', () => {
    for (const [name, screen] of NEGATIVE) {
      expect.soft(detectStartupDialog(screen), name).toBe(false);
    }
  });

  it('does NOT match Codex startup signals outside their bounded windows', () => {
    for (const [name, screen] of CODEX_NEGATIVE) {
      expect.soft(detectStartupDialog(screen, 'codex'), name).toBe(false);
    }
  });
});

describe('detectRuntimeMenu', () => {
  const POSITIVE: Array<[string, string]> = [
    [
      'superpowers picker: "Enter to select · ↑/↓ to navigate · Esc to cancel"',
      '❯ 1. Subagent-Driven (Recommended)\n  2. Inline Execution\n  3. Type something.\n  4. Chat about this\nEnter to select · ↑/↓ to navigate · Esc to cancel\n',
    ],
    [
      'single-choice confirm anchor "Enter to confirm · Esc to cancel"',
      '> Apply this refactor?\nEnter to confirm · Esc to cancel\n',
    ],
    [
      'overflow scroll-overlay mangles footer (real baxian-dev capture, task-064, 53-col pane): "Jump to bottom" hint overwrites the middle, width truncates "cancel"',
      '❯ 1. post-approve-complete（推荐）\n  2. post-approve-fixed\n  3. 保持 pr-merge-ready 不变\n  4. Type something.\n  5. Chat about this\n─────────────────────────────────────────────────────\nEnter to sel Jump to bottom (ctrl+End) ↓ ate · Esc to\n',
    ],
    [
      'narrow pane truncates the footer tail "cancel" but the Enter/Esc verbs survive',
      '❯ 1. Yes\n  2. No\nEnter to select · ↑/↓ to navigate · Esc to\n',
    ],
    [
      'indented footer (boxed menu) — line-start anchor tolerates leading whitespace',
      '  ❯ 1. Yes\n    2. No\n    Enter to select · Esc to cancel\n',
    ],
  ];

  const NEGATIVE: Array<[string, string]> = [
    [
      'healthy REPL with user-typed prefill bracketed by dividers (claude no-footer menu shape)',
      '✻ Worked for 5m 38s\n────────────────────────────────────────────────────────────────────────────────\n❯ 按方案 A 开分支重构\n────────────────────────────────────────────────────────────────────────────────\n  Opus 4.7 [###############     ] 75%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n',
    ],
    [
      'real baxian-dev capture: idle claude REPL with prefilled draft "直接push" (regression)',
      '  Read 1 file\n\n⏺ 全部 review 处理完。汇总：\n\n✻ Worked for 33m 3s\n\n───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n❯ 直接push\n───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  Opus 4.7 [#################   ] 85%\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #101\n',
    ],
    [
      'numbered picker structure when footer hints are hidden',
      '❯ 1. Subagent-Driven (Recommended)\n  2. Inline Execution\n  3. Type something.\n',
    ],
    [
      'healthy ready REPL screen',
      '❯ Try "fix typecheck errors"\n⏵⏵ bypass permissions on (shift+tab to cycle)\n',
    ],
    [
      'healthy ready REPL screen with non-English prompt',
      '❯ 按方案 A 开分支重构\n⏵⏵ bypass permissions on (shift+tab to cycle)\n',
    ],
    [
      'ready REPL prompt after a single divider',
      '────────────────────────────────────────────────────────────────────────────────\n❯ 按方案 A 开分支重构\n⏵⏵ bypass permissions on (shift+tab to cycle)\n',
    ],
    [
      'markdown quote text bracketed by ASCII separators',
      '------------------------------------------------------------\n> quoted text from command output\n------------------------------------------------------------\n',
    ],
    [
      'numbered list typed at a ready REPL prompt',
      '❯ 1. Write a regression test\n  2. Run the relevant test\n  3. Push the branch\n⏵⏵ bypass permissions on (shift+tab to cycle)\n',
    ],
    [
      'blank lines collapsed into a fake divider-bracketed picker',
      '────────────────────────────────────────────────────────────────────────────────\n\n❯ 按方案 A 开分支重构\n\n────────────────────────────────────────────────────────────────────────────────\n',
    ],
    ['Auto-updating with Unicode ellipsis (startup-only signal)', 'status bar: Auto-updating…\n'],
    ['Auto-updating with version target', 'Auto-updating to v2.1.87'],
    [
      'busy "Esc to interrupt" with an unrelated "Enter to" on a different line (same-line rule)',
      '❯ press Enter to send a follow-up\n⏺ Thinking…\n  Esc to interrupt\n',
    ],
    [
      'keyboard help in prose/tool output — line does not START with "Enter to"',
      'Press Enter to continue, Esc to abort\n',
    ],
    [
      'agent prose mentioning the keys mid-sentence',
      'Then hit Enter to select an option or Esc to cancel the dialog.\n',
    ],
    [
      'line-start keyboard hint without the "·" footer separator (tool/TUI output)',
      'Enter to continue, Esc to abort\n',
    ],
    [
      'line-start keyboard hint, comma-joined (tool/TUI output)',
      'Enter to accept, Esc to skip\n',
    ],
  ];

  it('matches every known runtime-menu anchor', () => {
    for (const [name, screen] of POSITIVE) {
      expect.soft(detectRuntimeMenu(screen), name).toBe(true);
    }
  });

  it('does NOT match REPL chrome / unrelated text', () => {
    for (const [name, screen] of NEGATIVE) {
      expect.soft(detectRuntimeMenu(screen), name).toBe(false);
    }
  });
});

describe('hasRuntimeReadyView', () => {
  it('accepts a claude-code idle composer without the footer anchor', () => {
    expect(hasRuntimeReadyView('✻ Worked for 10s\n\n❯ \n', 'claude-code')).toBe(true);
  });

  it('rejects small-pane fallback when the visible pane is busy or waiting on a menu/dialog', () => {
    for (const [name, screen] of [
      ['busy spinner', '✽ Grooving… (5m 21s · thinking)\n\n❯ \n'],
      ['runtime menu', '❯ \nEnter to select · ↑/↓ to navigate · Esc to cancel\n'],
      ['startup dialog', '❯ \nPress enter to continue\n'],
      ['trust dialog', 'Quick safety check\n❯ 1. Yes, I trust this folder\n'],
    ] as Array<[string, string]>) {
      expect.soft(hasRuntimeReadyView(screen, 'claude-code'), name).toBe(false);
    }
  });

  it('rejects claude-code when spinner is high on tall pane (full-screen check)', () => {
    const lines = [
      '✽ Grooving… (5m 21s · thinking)',
      ...Array(18).fill(''),
      '❯ ',
      '',
    ];
    expect(hasRuntimeReadyView(lines.join('\n'), 'claude-code')).toBe(false);
  });

  it('does not apply the claude small-pane fallback to codex', () => {
    expect(hasRuntimeReadyView('❯ \n', 'codex')).toBe(false);
  });

  it('accepts codex idle prompt with → arrow', () => {
    expect(hasRuntimeReadyView('→ baxian git:(main)\n', 'codex')).toBe(true);
  });

  it('accepts a bare › as codex idle (a cleared empty composer; busy/menu gating still applies)', () => {
    expect(hasRuntimeReadyView('› \n', 'codex')).toBe(true);
  });

  it('rejects codex → prompt when busy spinner is active', () => {
    const screen = '· Thinking… (5s)\n→ baxian git:(main)\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(false);
  });

  it('accepts codex → prompt when stale esc-to-interrupt is ABOVE the prompt', () => {
    const screen = 'Working on it…\n  esc to interrupt\n→ baxian git:(main)\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(true);
  });

  it('rejects codex → prompt when esc-to-interrupt is BELOW the prompt (active busy)', () => {
    const screen = '→ baxian git:(main)\nWorking on it…\n  esc to interrupt\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(false);
  });

  it('rejects codex → prompt when Working(...) is active in tail', () => {
    const screen = '→ baxian git:(main)\n• Working (8s)\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(false);
  });

  it('does not accept → output line (e.g. → run tests) as codex idle prompt', () => {
    expect(hasRuntimeReadyView('→ run tests\n', 'codex')).toBe(false);
  });

  it('does not accept indented → line as codex idle prompt', () => {
    expect(hasRuntimeReadyView('  → baxian git:(main)\n', 'codex')).toBe(false);
  });

  it('rejects codex → prompt when output follows it', () => {
    expect(hasRuntimeReadyView('→ baxian git:(main)\nStill working on the request...\n', 'codex')).toBe(false);
  });

  it('accepts codex backtrack hint footer (Esc on empty composer) as idle/ready', () => {
    const screen =
      '─ Worked for 1m 14s ─────────────────\n\n' +
      '› Use /skills to list available skills\n\n' +
      '  esc again to edit previous message\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(true);
  });

  it('only treats the backtrack hint as ready when it is the bottom footer (busy marker below → not ready)', () => {
    const screen =
      '› Use /skills to list available skills\n\n' +
      '  esc again to edit previous message\n' +
      '· Working (8s)\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(false);
  });

  it('does not treat the backtrack hint as ready for claude-code', () => {
    expect(hasRuntimeReadyView('  esc again to edit previous message\n', 'claude-code')).toBe(false);
  });

  it('opencode: idle composer footer without busy signals is ready', () => {
    expect(hasRuntimeReadyView('┃  Build auto · Zen\n   8.3K (4%)  ctrl+p commands\n', 'opencode')).toBe(true);
  });

  it('opencode: a working screen (progress bar + esc interrupt) is not ready', () => {
    expect(hasRuntimeReadyView('   ■■■⬝⬝⬝  esc interrupt          ctrl+p commands\n', 'opencode')).toBe(false);
  });

  it('qodercli: idle composer placeholder is ready', () => {
    expect(hasRuntimeReadyView('*   Type your message or @path/to/file\n', 'qodercli')).toBe(true);
  });

  it('qodercli: a thinking spinner screen is not ready', () => {
    expect(hasRuntimeReadyView('⠼ Thinking... (esc to cancel, 3s)\n', 'qodercli')).toBe(false);
  });

  it('opencode: a permission prompt that keeps the idle footer is not ready', () => {
    expect(hasRuntimeReadyView('△ Permission required\n  Allow once   Reject\n  ctrl+p commands\n', 'opencode')).toBe(false);
  });

  it.each([
    'Permission Required',
    'Allow this command to run?',
    'Do you want to allow this read?',
    'waiting for user confirmation',
    'awaiting approval',
    'allow once or always?',
    'asking user',
    'enter your response',
    'review your answers:',
    'shell awaiting input',
  ])('qodercli: pending prompt %j keeping the composer is not ready', (prompt) => {
    expect(hasRuntimeReadyView(`${prompt}\n  Type your message or @path\n`, 'qodercli')).toBe(false);
  });

  it('qodercli: a shortcuts/help overlay is not ready (footer alone is not an idle cue)', () => {
    expect(hasRuntimeReadyView('  keyboard shortcuts\n  ? for shortcuts\n', 'qodercli')).toBe(false);
  });
});

describe('runtimeBusyCheck (opencode/qodercli screen-only busy)', () => {
  it('opencode: esc interrupt hint is busy', () => {
    expect(runtimeBusyCheck('   ■■■⬝⬝⬝  esc interrupt\n', 'opencode')).toBe(true);
  });

  it('opencode: idle composer is not busy', () => {
    expect(runtimeBusyCheck('┃  Build auto · Zen\n   8.3K (4%)  ctrl+p commands\n', 'opencode')).toBe(false);
  });

  it('qodercli: "(esc to cancel," spinner is busy', () => {
    expect(runtimeBusyCheck('⠼ Thinking... (esc to cancel, 3s)\n', 'qodercli')).toBe(true);
  });

  it('qodercli: idle composer is not busy', () => {
    expect(runtimeBusyCheck('*   Type your message or @path/to/file\n', 'qodercli')).toBe(false);
  });

  it('opencode: ctrl+c interrupt hint alone (progress bar wrapped out of tail) is busy', () => {
    expect(runtimeBusyCheck('running a long tool call\n  ctrl+c to interrupt          ctrl+p commands\n', 'opencode')).toBe(true);
  });
});

const blank = (n: number): string[] => Array(n).fill('');

const CC_NONYOLO_IDLE = [
  " ▎ Run /model and select Fable to use it. Learn more",
  ...blank(27),
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯\u00a0",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  wd-cc Fable 5",
  "  ⏸ manual mode on · ← for agents",
].join('\n');

const CODEX_NONYOLO_IDLE = [
  "│                                                          │",
  "│ model:     gpt-5.5 xhigh   /model to change              │",
  "│ directory: /private/tmp/claude-501/…/yolo-probe/wd-codex │",
  "╰──────────────────────────────────────────────────────────╯",
  "",
  "  Tip: New Use /fast to enable our fastest inference with increased plan usage.",
  "",
  "• You have 2 usage limit resets available. Run /usage to use one.",
  "",
  "",
  "› Run /review on my current changes",
  "",
  "  gpt-5.5 xhigh · /private/tmp/claude-501/-Users-devuser--baxian-repos-example-baxian/f2fbbf50-44f3-4478-b9b7-2f1da4c55fad/scratchpad/yolo-probe/wd-codex",
  ...blank(35),
].join('\n');

const OC_NONYOLO_FRESH_IDLE = [
  "                                                                                 ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
  "",
  "",
  "                                                               ┃",
  "                                                               ┃  Ask anything... \"What is the tech stack of this project?\"",
  "                                                               ┃",
  "                                                               ┃  Build · GLM-5.2 Alibaba (China) · max",
  "                                                               ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  "                                                                                                               tab agents  ctrl+p commands",
  ...blank(18),
  "  /private/tmp/claude-501/-Users-devuser--baxian-repos-example-baxian/f2fbbf50-44f3-4478-b9b7-2f1da4c55fad/scratchpad/yolo-probe/wd-oc                                                         1.17.16",
  "",
].join('\n');

const OC_YOLO_FRESH_IDLE = [
  "                                                                                 ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
  "",
  "",
  "                                                               ┃",
  "                                                               ┃  Ask anything... \"What is the tech stack of this project?\"",
  "                                                               ┃",
  "                                                               ┃  Build auto · GLM-5.2 Alibaba (China) · max",
  "                                                               ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  "                                                                                                               tab agents  ctrl+p commands",
  ...blank(18),
  "  /private/tmp/claude-501/-Users-devuser--baxian-repos-example-baxian/f2fbbf50-44f3-4478-b9b7-2f1da4c55fad/scratchpad/yolo-probe/wd-oc2                                                        1.17.17",
  "",
].join('\n');

const QODER_NONYOLO_FRESH_IDLE = [
  " ██      ██                            │ 1. Create AGENTS.md files to customize interactions          │",
  " ██  ██  ██  Qoder CLI v1.0.41         │ 2. /help for more information                                │",
  " ██    ██                              │ 3. Ask coding questions, edit code or run commands           │",
  "   ████  ██  Signed in Browser Login   │ 4. Be specific for the best results                          │",
  "                                       ╰──────────────────────────────────────────────────────────────╯",
  "",
  "",
  "                                                                                                                                                                                        ? for shortcuts",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " Shift+Tab to Accept Edits                                                                                                                                                  Try /model to switch models",
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
  " >   Type your message or @path/to/file",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  " GLM-5.2 (Alibaba Cloud Model Studio - China) Model · ctx ░░░░░░░░░░ 0%",
  ...blank(34),
].join('\n');

const QODER_YOLO_FRESH_IDLE = [
  " ██      ██                            │ 1. Create AGENTS.md files to customize interactions          │",
  " ██  ██  ██  Qoder CLI v1.0.41         │ 2. /help for more information                                │",
  " ██    ██                              │ 3. Ask coding questions, edit code or run commands           │",
  "   ████  ██  Signed in Browser Login   │ 4. Be specific for the best results                          │",
  "                                       ╰──────────────────────────────────────────────────────────────╯",
  "",
  "",
  "                                                                                                                                                                                        ? for shortcuts",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " YOLO Shift+Tab to Auto Mode                                                                                                                                                Try /model to switch models",
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
  " *   Type your message or @path/to/file",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  " GLM-5.2 (Alibaba Cloud Model Studio - China) Model · ctx ░░░░░░░░░░ 0%",
  ...blank(34),
].join('\n');

const CC_NONYOLO_BASH_PERMISSION = [
  "⏺ bx475",
  "",
  "✻ Churned for 10s",
  "",
  "❯ Run this exact bash command: touch /tmp/bx475-perm-probe",
  "",
  "⏺ Running 1 shell command…",
  "  ⎿  $ touch /tmp/bx475-perm-probe",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   touch /tmp/bx475-perm-probe",
  "   Create empty file /tmp/bx475-perm-probe",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to tmp/ from this project",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
  ...blank(6),
].join('\n');

const CODEX_NONYOLO_ESCALATION = [
  "• Done.",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "",
  "",
  "› Run this exact bash command: touch ~/bx475-perm-probe",
  "",
  "",
  "• Running touch ~/bx475-perm-probe",
  "",
  "",
  "  Would you like to run the following command?",
  "",
  "  Environment: local",
  "",
  "  Reason: Do you want to allow creating /Users/devuser/bx475-perm-probe in your home directory?",
  "",
  "  $ touch ~/bx475-perm-probe",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `touch '~/bx475-perm-probe'` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
].join('\n');

const OC_NONYOLO_EXTERNAL_DIR_PERMISSION = [
  "  ┃",
  "  ┃  Run this exact bash command: touch /tmp/bx475-perm-probe",
  "  ┃",
  "",
  "     $ touch /tmp/bx475-perm-probe",
  "",
  "     ▣  Build · GLM-5.2",
  ...blank(14),
  "  ┃",
  "  ┃  △ Permission required",
  "  ┃    ← Access external directory /tmp",
  "  ┃",
  "  ┃  Patterns",
  "  ┃                                                                                                                                                             /private/tmp/claude-501/-Users-",
  "  ┃  - /tmp/*                                                                                                                                                   devuser--baxian-repos-example-baxian/",
  "  ┃                                                                                                                                                             f2fbbf50-44f3-4478-b9b7-2f1da4c55fad/",
  "  ┃                                                                                                                                                             scratchpad/yolo-probe/wd-oc",
  "  ┃   Allow once   Allow always   Reject                                                                       ctrl+f fullscreen  ⇆ select  enter confirm",
  "  ┃                                                                                                                                                             • OpenCode 1.17.16",
  "",
].join('\n');

const QODER_NONYOLO_SHELL_PERMISSION = [
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
  " > Run this exact bash command: echo bx475",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  "",
  " Thinking",
  " │ The user wants me to run a specific bash command.",
  " ? Bash(echo bx475)",
  "",
  " Permission Required",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " Tool: Bash",
  "",
  " Print bx475",
  " Command: echo bx475",
  "",
  " Allow this command to run?",
  "",
  "  ❯ 1. Allow once",
  "    2. Always allow \"echo\" for future sessions [local]",
  "    3. Reject and type something",
  "    4. No",
  ...blank(20),
].join('\n');
describe('non-yolo & fresh-screen geometry (real captures)', () => {
  it.each([
    ['claude-code non-yolo idle (❯ + NBSP composer)', CC_NONYOLO_IDLE, 'claude-code'],
    ['codex non-yolo idle (generic footer anchor)', CODEX_NONYOLO_IDLE, 'codex'],
    ['opencode non-yolo fresh idle (footer above blank sea)', OC_NONYOLO_FRESH_IDLE, 'opencode'],
    ['opencode --auto fresh idle', OC_YOLO_FRESH_IDLE, 'opencode'],
    ['qodercli non-yolo fresh idle (top-anchored, 34 trailing blanks)', QODER_NONYOLO_FRESH_IDLE, 'qodercli'],
    ['qodercli --dangerously-skip-permissions fresh idle', QODER_YOLO_FRESH_IDLE, 'qodercli'],
  ] as const)('%s is ready and not busy', (_name, screen, runtime) => {
    expect(runtimeBusyCheck(screen, runtime)).toBe(false);
    expect(hasRuntimeReadyView(screen, runtime)).toBe(true);
  });

  it.each([
    ['claude-code bash permission prompt', CC_NONYOLO_BASH_PERMISSION, 'claude-code'],
    ['codex escalation prompt', CODEX_NONYOLO_ESCALATION, 'codex'],
    ['opencode external-directory permission prompt', OC_NONYOLO_EXTERNAL_DIR_PERMISSION, 'opencode'],
    ['qodercli shell permission prompt', QODER_NONYOLO_SHELL_PERMISSION, 'qodercli'],
  ] as const)('%s blocks the ready gate', (_name, screen, runtime) => {
    expect(hasRuntimeReadyView(screen, runtime)).toBe(false);
  });

  it('opencode: busy bar above the blank sea is still busy', () => {
    const screen = ['  ┃  ■■■■⬝⬝⬝⬝  esc interrupt', ...blank(12), '  /w  1.17.17'].join('\n');
    expect(runtimeBusyCheck(screen, 'opencode')).toBe(true);
  });

  it('qodercli: spinner above 34 trailing blank rows is still busy', () => {
    const screen = [' ⠼ Thinking... (esc to cancel, 3s)', ...blank(34)].join('\n');
    expect(runtimeBusyCheck(screen, 'qodercli')).toBe(true);
  });
});

describe('hasOscTitleIdle', () => {
  it.each([
    ['claude-code idle title with task summary', '✳ 分析 baxian 服务', 'claude-code' as const, true],
    ['claude-code idle title without a task yet', '✳ Claude Code', 'claude-code' as const, true],
    ['braille spinner prefix means working, not idle', '⠹ 分析 baxian 服务', 'claude-code' as const, false],
    ['empty title (pane_title unavailable)', '', 'claude-code' as const, false],
    ['✳ without the following space is not the idle contract', '✳分析', 'claude-code' as const, false],
    ['codex cwd-shaped title has no idle contract', 'baxian', 'codex' as const, false],
    ['codex: even a ✳-prefixed title is not an idle signal', '✳ x', 'codex' as const, false],
    ['opencode title has no idle contract', 'OC | some session', 'opencode' as const, false],
    ['qodercli Ready title is not an idle signal (shown while working too)', '◇  Ready (repo)', 'qodercli' as const, false],
  ])('%s → %s', (_label, title, runtime, expected) => {
    expect(hasOscTitleIdle(title, runtime)).toBe(expected);
  });
});

describe('detectRuntimePendingPrompt', () => {
  it.each([
    ['bash permission prompt', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n', true],
    ['legacy waiting-for-permission', 'Waiting for permission…\n', true],
    ['connection allow prompt', 'Do you want to allow this connection?\n1. Yes\n', true],
    ['select-option footer, narrow-wrapped', 'Enter to select ·\nEsc to cancel\n', true],
    ['dynamic workflow prompt', 'Run a dynamic workflow?\nEnter to run · Esc to cancel\n', true],
    ['bash amend footer with option lines', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\ntab to amend · esc to cancel\n', true],
    ['explain footer with option lines', 'rm -rf build\n❯ 1. Yes\nctrl+e to explain this command\n', true],
    ['offer with a numbered Yes option line', 'Would you like to create a plan?\n❯ 1. Yes\n  2. No\n', true],
    ['offer with a selected non-yes option line', 'Do you want to continue?\n❯ 2. No, cancel\n', true],
    ['offer with bare unnumbered Yes options (inverse-video selection, no ❯ after stripAnsi)', 'Do you want to proceed?\nYes\nNo\n', true],
    ['offer with a bare Yes-and-dont-ask variant', "Do you want to proceed?\nYes, and don't ask again\nNo\n", true],
    ['offer with only a numbered No option visible', 'Do you want to proceed?\n  2. No\n', true],
    ['bare yes at line start in prose without an offer phrase', 'yes 分支的判定已经覆盖。\n', false],
    ['plan-mode review prompt', 'Review your answers\n', true],
    ['skip-interview prompt', 'Skip interview and plan immediately\n', true],
    ['narrow-wrapped confirm footer (enter to confirm)', '确认删除分支？\nEnter to confirm ·\nEsc to cancel\n', true],
    ['narrow-wrapped skip-interview blocker', 'Skip interview and plan\nimmediately\n', true],
    ['narrow-wrapped offer phrase with a Yes option', 'Would you like\nto apply this plan?\n❯ 1. Yes\n  2. No\n', true],
    ['composer draft after a quoted offer phrase is not a prompt option', '表单文案是 "Would you like to apply?"。\n❯ run tests\n', false],
    ['offer phrase alone in prose (no option line)', 'Would you like me to proceed with the merge?\n', false],
    ['proceed question quoted in prose (no option line)', '日志里出现 Do you want to proceed? 即为权限提示。\n', false],
    ['amend hotkey explained in prose (no option line)', '权限表单支持 tab to amend 快捷键。\n', false],
    ['dynamic workflow phrase in prose (no esc to cancel)', '我加了 run a dynamic workflow? 的检测。\n', false],
    ['enter-to-select alone in prose (no esc to cancel)', '在 TUI 里 enter to select 表示确认当前项。\n', false],
    ['plain idle composer tail', '✻ Worked for 31s\n\n❯ \n⏵⏵ bypass permissions on\n', false],
    ['phrase outside the 15-line tail window (no rule on screen)', 'do you want to proceed?\n' + 'x\n'.repeat(16) + '❯ \n', false],
    [
      'tall permission form: offer above the 15-line tail but inside the active form region',
      '正文历史\n' + '─'.repeat(40) + '\nWould you like to apply this plan?\n' + 'plan detail\n'.repeat(16) + '❯ 1. Yes\n  2. No\n',
      true,
    ],
    [
      'prose mention above the composer box rule is outside the active form region',
      'Do you want to proceed? 的检测已补充。\n' + '─'.repeat(40) + '\n❯ \n' + '─'.repeat(40) + '\n  ⏵⏵ bypass permissions on\n',
      false,
    ],
  ])('%s → %s', (_label, screen, expected) => {
    expect(detectRuntimePendingPrompt(screen)).toBe(expected);
  });
});

describe('detectRuntimeOverlay', () => {
  it.each([
    ['transcript viewer footer (ctrl+o)', '  transcript line\n\nctrl+o to toggle · esc to close\n', true],
    ['narrow-wrapped transcript viewer footer (close on its own line)', 'transcript line\nctrl+o to toggle · esc to\nclose\n', true],
    ['narrow-wrapped detailed-transcript header', 'Showing detailed\ntranscript\n', true],
    ['transcript viewer detailed header as last line', 'Showing detailed transcript\n', true],
    ['transcript viewer scroll hint', 'some output\n↑↓ scroll · q quit\n', true],
    ['transcript viewer collapse hint', 'ctrl+e collapse view\n', true],
    ['model picker menu', 'Select model\n❯ 1. Fable\n  2. Opus\nenter to set as default\n', true],
    ['normal idle footer', '✻ Worked for 31s\n\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)\n', false],
    ['ctrl+o mentioned mid-text, above the 2-line footer window', 'ctrl+o to toggle 是转录视图快捷键。\n正文继续。\n结论：已覆盖。\n', false],
    ['select model mentioned without the set-as-default footer', '我用 /model 打开 select model 菜单做了对比。\n', false],
  ])('%s → %s', (_label, screen, expected) => {
    expect(detectRuntimeOverlay(screen)).toBe(expected);
  });
});

describe('runtimeBusyCheck', () => {
  it('codex: stale esc-to-interrupt above → prompt is NOT busy (position-aware)', () => {
    const screen = 'Working on it…\n  esc to interrupt\n→ baxian git:(main)\n';
    expect(runtimeBusyCheck(screen, 'codex')).toBe(false);
  });

  it('codex: active esc-to-interrupt below → prompt IS busy', () => {
    const screen = '→ baxian git:(main)\nWorking on it…\n  esc to interrupt\n';
    expect(runtimeBusyCheck(screen, 'codex')).toBe(true);
  });

  it('claude-code: spinner high on tall pane IS busy (full-screen check)', () => {
    const lines = [
      '✽ Grooving… (5m 21s · thinking)',
      ...Array(18).fill(''),
      '❯ ',
      '',
    ];
    expect(runtimeBusyCheck(lines.join('\n'), 'claude-code')).toBe(true);
  });

  it('codex: same tall-pane spinner is NOT busy (position-aware only checks tail)', () => {
    const lines = [
      '✽ Grooving… (5m 21s · thinking)',
      ...Array(18).fill(''),
      '→ baxian git:(main)',
      '',
    ];
    expect(runtimeBusyCheck(lines.join('\n'), 'codex')).toBe(false);
  });
});

describe('hasRuntimeReadyView accepts a cleared bare Codex › only when nothing runtime-owned is on screen', () => {
  it('treats a bare › (only blank lines below) as a ready idle composer', () => {
    expect(hasRuntimeReadyView('› \n', 'codex')).toBe(true);
    expect(hasRuntimeReadyView('output scrolled up\n›\n\n', 'codex')).toBe(true);
  });
  it('accepts an INDENTED bare › — Codex indents the empty prompt marker', () => {
    expect(hasRuntimeReadyView('  › \n', 'codex')).toBe(true);
    expect(hasRuntimeReadyView('prior output\n  ›\n', 'codex')).toBe(true);
  });
  it('does NOT treat a bare › as ready when a busy turn marker is still on screen', () => {
    expect(hasRuntimeReadyView('· Working… (12s)\n  esc to interrupt\n› \n', 'codex')).toBe(false);
  });
  it('does NOT treat a bare › as ready under a permission/confirm blocker', () => {
    expect(hasRuntimeReadyView('Allow command `rm`?\n  Press Enter to confirm or Esc to cancel\n› \n', 'codex')).toBe(false);
  });
  it('does NOT treat a node/shell > as a Codex composer', () => {
    expect(hasRuntimeReadyView('> require("fs")\n> \n', 'codex')).toBe(false);
  });

  it('does NOT treat a bare › as ready when ordinary user text follows it (pasted/leftover transcript)', () => {
    expect(hasRuntimeReadyView('›\nplease finish the refactor\n', 'codex')).toBe(false);
    expect(hasRuntimeReadyView('some output\n›\nleftover line\n  gpt-5.5 xhigh · ~/repo\n', 'codex')).toBe(false);
  });
  it('does NOT treat a bare › with a status footer DIRECTLY below it as empty (that shape is the with-text form)', () => {
    expect(hasRuntimeReadyView('› \n  gpt-5.5 xhigh · ~/repo\n', 'codex')).toBe(false);
    expect(hasRuntimeReadyView('› \n  gpt-5.5 xhigh · /Users/x/repo\n', 'codex')).toBe(false);
  });
  it('does NOT treat a › followed by a dirty/non-blank line then a footer as ready', () => {
    expect(hasRuntimeReadyView('›\nold output\n› new dirty prompt text\n  gpt-5.5 xhigh · ~/repo\n', 'codex')).toBe(false);
    expect(hasRuntimeReadyView('›\n  see logs · /tmp/out and fix it\n', 'codex')).toBe(false);
    expect(hasRuntimeReadyView('›\n  - refactor auth · update tests · ship\n  gpt-5.5 xhigh · ~/repo\n', 'codex')).toBe(false);
  });
});

describe('hasOscTitleWorking', () => {
  it('matches a braille-spinner OSC pane title (same pattern both runtime manifests use)', () => {
    expect(hasOscTitleWorking('⠁ Reading file')).toBe(true);
    expect(hasOscTitleWorking('⣿ Working')).toBe(true);
  });
  it('does NOT match an idle/non-spinner title or a bare proc name', () => {
    expect(hasOscTitleWorking('baxian · main')).toBe(false);
    expect(hasOscTitleWorking('✳ idle')).toBe(false);
    expect(hasOscTitleWorking('node')).toBe(false);
    expect(hasOscTitleWorking('')).toBe(false);
    expect(hasOscTitleWorking('⠁no-space-after-spinner')).toBe(false);
  });
});

describe('hasRuntimeIdleComposerPrompt', () => {
  it('detects codex → prompt in tail', () => {
    const screen = 'some output\n→ baxian git:(main)\n';
    expect(hasRuntimeIdleComposerPrompt(screen, 'codex')).toBe(true);
  });

  it('detects codex → prompt without git info', () => {
    expect(hasRuntimeIdleComposerPrompt('→ myproject\n', 'codex')).toBe(true);
  });

  it('matches a bare › empty composer — only blank lines may follow (col-0 OR indented marker)', () => {
    expect(hasRuntimeIdleComposerPrompt('› \n', 'codex')).toBe(true);
    expect(hasRuntimeIdleComposerPrompt('  ›\n', 'codex')).toBe(true);
    expect(hasRuntimeIdleComposerPrompt('old output\n  ›\n\n', 'codex')).toBe(true);
    expect(hasRuntimeIdleComposerPrompt('› with text\n', 'codex')).toBe(false);
    expect(hasRuntimeIdleComposerPrompt('› \n  gpt-5.5 xhigh · ~/repo\n', 'codex')).toBe(false);
  });

  it('a bare › is empty only when ONLY blank lines follow — any non-blank line below means dirty', () => {
    expect(hasRuntimeIdleComposerPrompt('›\nleftover user text\n', 'codex')).toBe(false);
    expect(hasRuntimeIdleComposerPrompt('›\nold output\n› still typing\n', 'codex')).toBe(false);
    expect(hasRuntimeIdleComposerPrompt('› old typing\n  wrapped\n  ›\n', 'codex')).toBe(true);
  });

  it('does not match → followed by multi-word content (output, not prompt)', () => {
    expect(hasRuntimeIdleComposerPrompt('→ run tests now\n', 'codex')).toBe(false);
  });

  it('does not match → prompt when output follows it', () => {
    expect(hasRuntimeIdleComposerPrompt('→ baxian git:(main)\nStill working on the request...\n', 'codex')).toBe(false);
  });

  it('rejects codex when prompt is not in tail', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    lines[0] = '→ baxian git:(main)';
    expect(hasRuntimeIdleComposerPrompt(lines.join('\n'), 'codex')).toBe(false);
  });

  it('still works for claude-code', () => {
    expect(hasRuntimeIdleComposerPrompt('❯ \n', 'claude-code')).toBe(true);
  });
});

describe('detectReplActiveBusy', () => {
  const STATUS_TAIL = [
    '────────────────────────────────────────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────────────────────────────────────────',
    '  Opus 4.7 [#################   ] 87%',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');

  const POSITIVE: Array<[string, string]> = [
    ['live spinner (claude-code)', '· Stewing… (24s)'],
    ['live spinner in middle of viewport', '❯ user prompt\n\n· Wrangling… (2m 42s)\n\n' + STATUS_TAIL],
    ['codex "esc to interrupt" in tail', 'Working on it…\n  esc to interrupt'],
    ['claude-code early-thinking with Esc to interrupt in tail', '⏵ Thinking…\n\n  Esc to interrupt'],
  ];

  const NEGATIVE: Array<[string, string]> = [
    ['idle REPL prompt', '⏵⏵ bypass permissions on ~/code\n\n>'],
    [
      'history mentions `esc to interrupt` phrase but runtime is idle (regression: was busy under detectBusy)',
      [
        '⏺ 之前讨论过：detectBusy 用字面 "esc to interrupt" 匹配，会被历史误报。',
        '',
        '所以现在改用 spatial-scoped detector，把这个 phrase 的判定限制到 viewport 底部状态区。',
        '',
        '✻ Worked for 5m 38s',
        '',
        STATUS_TAIL,
      ].join('\n'),
    ],
    [
      'user prompt quotes "Esc to interrupt" (case-insensitive) but pane is idle',
      [
        '❯ 请解释 Esc to interrupt 在 Claude Code 状态条下方什么时候显示',
        '',
        '✻ Worked for 12s',
        '',
        STATUS_TAIL,
      ].join('\n'),
    ],
    ['spinner-shaped line in history with subsequent Worked for marker', '· Wrangling… (24s)\n\n✻ Worked for 24s\n\n' + STATUS_TAIL],
    ['empty string', ''],
  ];

  it('matches every active-task signal (spinner anywhere, esc-to-interrupt in tail)', () => {
    for (const [name, screen] of POSITIVE) {
      expect.soft(detectReplActiveBusy(screen), name).toBe(true);
    }
  });

  it('rejects idle / history-only / quoted-text false positives', () => {
    for (const [name, screen] of NEGATIVE) {
      expect.soft(detectReplActiveBusy(screen), name).toBe(false);
    }
  });
});

describe('hasActiveSpinner (the only signal that MUST tick during genuine work)', () => {
  it('matches a live incomplete spinner', () => {
    for (const [name, screen] of [
      ['claude spinner with duration', '· Wrangling… (2m 42s · esc to interrupt)'],
      ['spinner mid-viewport', '❯ prompt\n\n✻ Pondering… (24s)\n'],
    ] as Array<[string, string]>) {
      expect.soft(hasActiveSpinner(screen), name).toBe(true);
    }
  });

  it('does NOT match a static busy anchor without a spinner, or a completed spinner', () => {
    for (const [name, screen] of [
      ['codex static busy (esc to interrupt only, no spinner)', 'Working on it…\n  esc to interrupt'],
      ['esc to interrupt anchor alone', '  esc to interrupt'],
      ['spinner-shaped line already completed (Worked for marker after)', '· Wrangling… (24s)\n\n✻ Worked for 24s\n'],
      ['idle ready prompt', '❯ \n'],
      ['empty', ''],
    ] as Array<[string, string]>) {
      expect.soft(hasActiveSpinner(screen), name).toBe(false);
    }
  });
});

describe('hasActiveSpinnerInTail (active-region-scoped, used for stuck-busy)', () => {
  it('matches a spinner in the activity region just above the footer', () => {
    const screen = [
      '· Wrangling… (42s)',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  Opus 4.7 [#################   ] 87%',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(hasActiveSpinnerInTail(screen)).toBe(true);
  });

  it('does NOT match a quoted/leftover spinner high in scrollback above an idle prompt', () => {
    const screen = ['· Wrangling… (24s)', ...Array(12).fill(''), '❯ '].join('\n');
    expect(hasActiveSpinner(screen)).toBe(true);
    expect(hasActiveSpinnerInTail(screen)).toBe(false);
  });
});

describe('window geometry read (twelve-field single read)', () => {
  const GEOM_LINE = '200 50 on latest 42|123|1700000000|$7|dev-1|3.6a|1|$7\n';

  it('getWindowGeometry issues one display-message carrying geometry, owner state, identity, claim, version, and the feature probe', async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValue({ stdout: GEOM_LINE, stderr: '', exitCode: 0 });
    const tmux = new TmuxManager(runner);
    const geom = await tmux.getWindowGeometry('dev-1', { timeout: 1234 });
    const cmd = lastCmd(runner);
    expect(cmd).toContain("display-message -p -t '=dev-1:'");
    expect(cmd).toContain('#{window_width} #{window_height} #{status} #{window-size}');
    expect(cmd).toContain('#{@bx_owner_gen}|#{pid}|#{start_time}|#{session_id}|#{@baxian-agent-id}|#{version}|#{e|<=:1,2}|#{session_id}');
    expect(runner.exec.mock.calls.at(-1)?.[1]).toEqual({ timeout: 1234 });
    expect(geom).toEqual({
      width: 200,
      height: 50,
      statusLines: 1,
      sizeMode: 'latest',
      ownerGen: 42,
      ref: { serverPid: '123', serverStart: '1700000000', sessionId: '$7' },
      claim: 'dev-1',
      ownerWriteCapability: 'full',
    });
  });

  it('getWindowGeometry three-state failures: proven-absent is typed, transient exit 255 is NOT absent', async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValue({ stdout: '', stderr: "can't find session: dev-1", exitCode: 1 });
    const tmux = new TmuxManager(runner);
    await expect(tmux.getWindowGeometry('dev-1')).rejects.toBeInstanceOf(SessionAbsentError);

    runner.exec.mockResolvedValue({ stdout: '', stderr: 'ssh: connect to host x: Connection timed out', exitCode: 255 });
    const err = await tmux.getWindowGeometry('dev-1').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SessionAbsentError);
    expect(err).toBeInstanceOf(TmuxOutcomeUnknownError);
  });

  it('getWindowGeometry: tmux >= 3.6 no-target expansion (exit 0, empty session_id) is typed absent, not unparseable', async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValue({ stdout: '  on latest |2491|1784128830|||3.6a|1|\n', stderr: '', exitCode: 0 });
    const tmux = new TmuxManager(runner);
    await expect(tmux.getWindowGeometry('dev-1')).rejects.toBeInstanceOf(SessionAbsentError);
  });

  it('getWindowGeometry: no-target expansion polluted by a global @-option smuggling pipes is STILL typed absent', async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValue({ stdout: '  on latest ||||84630|1785741685|||3.6a|1|\n', stderr: '', exitCode: 0 });
    const tmux = new TmuxManager(runner);
    await expect(tmux.getWindowGeometry('dev-1')).rejects.toBeInstanceOf(SessionAbsentError);
  });

  it('getWindowGeometry: an empty-tailed line without the format separators is unparseable, NOT absent', async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValue({ stdout: 'x|\n', stderr: '', exitCode: 0 });
    const tmux = new TmuxManager(runner);
    const err = await tmux.getWindowGeometry('dev-1').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SessionAbsentError);
    expect((err as Error).message).toMatch(/unparseable/);
  });

  it('getWindowGeometry: unclaimed session (empty claim, session_id present) is NOT mistaken for absent', async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValue({ stdout: '80 24 on manual |9|8|$1||3.6a|1|$1\n', stderr: '', exitCode: 0 });
    const tmux = new TmuxManager(runner);
    const geom = await tmux.getWindowGeometry('dev-1');
    expect(geom.ref.sessionId).toBe('$1');
    expect(geom.claim).toBe('');
  });

  it('getWindowGeometry: live session whose owner-gen option smuggles pipes stays fail-closed (unparseable, NOT absent)', async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValue({ stdout: '80 24 on latest ||||55388|1785690647|$0||3.6a|1|$0\n', stderr: '', exitCode: 0 });
    const tmux = new TmuxManager(runner);
    const err = await tmux.getWindowGeometry('dev-1').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SessionAbsentError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/unparseable/);
  });

  it('getWindowGeometry: exit 0 with empty stdout is unparseable, NOT absent', async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const tmux = new TmuxManager(runner);
    const err = await tmux.getWindowGeometry('dev-1').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SessionAbsentError);
    expect((err as Error).message).toMatch(/unparseable/);
  });

  it.each([
    ['off status → 0 lines', '120 40 off latest |1|2|$3|dev-1|3.6a|1|$3', 0],
    ['on status → 1 line', '120 40 on latest |1|2|$3|dev-1|3.6a|1|$3', 1],
    ['multi-row status "3" → 3 lines', '120 40 3 latest |1|2|$3|dev-1|3.6a|1|$3', 3],
  ])('parseWindowGeometry: %s', (_name, line, statusLines) => {
    expect(parseWindowGeometry(line).statusLines).toBe(statusLines);
  });

  it('parseWindowGeometry: unset owner gen is null; empty claim is preserved (unclaimed session)', () => {
    const geom = parseWindowGeometry('80 24 on manual |9|8|$1||3.1c|#{e|<=:1,2}|$1');
    expect(geom.ownerGen).toBeNull();
    expect(geom.sizeMode).toBe('manual');
    expect(geom.claim).toBe('');
    expect(geom.ownerWriteCapability).toBe('legacy');
  });

  it.each([
    ['probe evaluates to 1 → full regardless of version text', '3.1c', '1', 'full'],
    ['literal echo + parseable pre-3.2 version → legacy', '3.1c', '#{e|<=:1,2}', 'legacy'],
    ['literal echo + parseable 3.0 version → legacy', '3.0a', '#{e|<=:1,2}', 'legacy'],
    ['empty probe + >=3.2 version is contradictory → unknown', '3.6a', '', null],
    ['garbage probe + garbage version → unknown', 'openbsd-tmux', 'garbage', null],
    ['empty probe + empty version → unknown', '', '', null],
  ])('classifyOwnerWriteCapability: %s', (_name, version, probe, expected) => {
    expect(classifyOwnerWriteCapability(version, probe)).toBe(expected);
  });

  it.each([
    ['garbage', 'not a geometry line'],
    ['unknown status value', '80 24 blinking latest |1|2|$3|dev-1|3.6a|1|$3'],
    ['non-numeric owner gen', '80 24 on latest abc|1|2|$3|dev-1|3.6a|1|$3'],
    ['zero width', '0 24 on latest |1|2|$3|dev-1|3.6a|1|$3'],
    ['missing claim/version fields (old nine-field line)', '80 24 on latest |1|2|$3|1'],
    ['missing trailing session_id slot (pre-sentinel line)', '120 40 on latest |1|2|$3|dev-1|3.6a|1'],
  ])('parseWindowGeometry rejects %s', (_name, line) => {
    expect(() => parseWindowGeometry(line)).toThrow();
  });

  it('parseStatusLines rejects values outside off/on/2-5', () => {
    expect(() => parseStatusLines('6')).toThrow(/status/);
    expect(() => parseStatusLines('yes')).toThrow(/status/);
  });

  it('contentArea subtracts status lines with a floor of one row; desiredTty adds them back (runaway guard)', () => {
    expect(contentArea({ cols: 100, rows: 31 }, 1)).toEqual({ cols: 100, rows: 30 });
    expect(contentArea({ cols: 100, rows: 2 }, 3)).toEqual({ cols: 100, rows: 1 });
    expect(desiredTty({ width: 100, height: 30, statusLines: 1 })).toEqual({ cols: 100, rows: 31 });
    const roundTrip = desiredTty({ width: 100, height: 30, statusLines: 1 });
    expect(contentArea(roundTrip, 1)).toEqual({ cols: 100, rows: 30 });
  });
});

describe('ownerWrite (session-triple ∧ claim ∧ generation server-side guard)', () => {
  const REF = { serverPid: '123', serverStart: '1700000000', sessionId: '$7' };

  it('full capability: single if-shell whose guard binds pid, start_time, session_id, claim, and monotonic gen', async () => {
    const runner = mockRunner();
    const tmux = new TmuxManager(runner);
    await tmux.ownerWrite('dev-1', REF, 'dev-1', 99, 'manual', { cols: 120, rows: 30 }, { timeout: 500 });
    const cmd = lastCmd(runner);
    expect(cmd).toContain("if-shell -F -t '=dev-1:'");
    expect(cmd).toContain('#{==:#{pid},123}');
    expect(cmd).toContain('#{==:#{start_time},1700000000}');
    expect(cmd).toContain('#{==:#{session_id},$7}');
    expect(cmd).toContain('#{==:#{@baxian-agent-id},dev-1}');
    expect(cmd).toContain('#{?#{@bx_owner_gen},#{e|<=:#{@bx_owner_gen},99},1}');
    expect(cmd).toContain('set-option -t "=dev-1:" @bx_owner_gen 99');
    expect(cmd).toContain('set-option -t "=dev-1:" window-size manual');
    expect(cmd).toContain('resize-window -t "=dev-1:" -x 120 -y 30');
    expect(runner.exec.mock.calls.at(-1)?.[1]).toEqual({ timeout: 500 });
  });

  it('legacy (gen=null): triple ∧ claim guard only — still an if-shell, no numeric compare, no gen write', async () => {
    const runner = mockRunner();
    const tmux = new TmuxManager(runner);
    await tmux.ownerWrite('dev-1', REF, 'dev-1', null, 'manual', undefined);
    const cmd = lastCmd(runner);
    expect(cmd).toContain('if-shell -F');
    expect(cmd).toContain('#{==:#{@baxian-agent-id},dev-1}');
    expect(cmd).toContain('#{==:#{session_id},$7}');
    expect(cmd).not.toContain('e|<=');
    expect(cmd).not.toContain('@bx_owner_gen');
  });

  it('latest mode omits the resize action', async () => {
    const runner = mockRunner();
    const tmux = new TmuxManager(runner);
    await tmux.ownerWrite('dev-1', REF, 'dev-1', 100, 'latest', undefined);
    const cmd = lastCmd(runner);
    expect(cmd).toContain('window-size latest');
    expect(cmd).not.toContain('resize-window');
  });

  it('rejects malformed refs, claims, and generations before touching tmux', async () => {
    const runner = mockRunner();
    const tmux = new TmuxManager(runner);
    await expect(
      tmux.ownerWrite('dev-1', { serverPid: 'x', serverStart: '1', sessionId: '$1' }, 'dev-1', 1, 'latest', undefined),
    ).rejects.toThrow(/malformed session ref/);
    await expect(
      tmux.ownerWrite('dev-1', REF, 'bad claim!', 1, 'latest', undefined),
    ).rejects.toThrow(/unsupported characters/);
    await expect(
      tmux.ownerWrite('dev-1', REF, 'dev-1', -5, 'latest', undefined),
    ).rejects.toThrow(/invalid generation/);
    expect(runner.exec).not.toHaveBeenCalled();
  });

  it('propagates a non-zero exit as an error (outcome handling stays with the caller)', async () => {
    const runner = mockRunner();
    runner.exec.mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 1 });
    const tmux = new TmuxManager(runner);
    await expect(tmux.ownerWrite('dev-1', REF, 'dev-1', 1, 'latest', undefined)).rejects.toThrow(/boom/);
  });
});
