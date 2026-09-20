import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TmuxManager, TmuxOutcomeUnknownError, PaneGoneError, SessionAbsentError, ReplNotReadyError, tmuxQuote, classifyOwnerWriteCapability, contentArea, desiredTty, parseStatusLines, parseWindowGeometry, detectStartupDialog, hasReplProcTitle } from '../../src/agent/tmux.js';
import { fakeRunner, foregroundCondAccepts } from '../helpers/fake-runner.js';
import type { PaneRef } from '../../src/agent/tmux.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { blank, CC_NONYOLO_BASH_PERMISSION, CODEX_NONYOLO_ESCALATION } from './runtime-captures.js';
import { classifyScreen } from '../../src/agent/detect/classify.js';

type ExecMock = ReturnType<typeof vi.fn<CommandRunner['exec']>>;
type StdinMock = ReturnType<typeof vi.fn<CommandRunner['execWithStdin']>>;

function mockRunner(): CommandRunner & { exec: ExecMock; execWithStdin: StdinMock } {
  return {
    exec: vi.fn<CommandRunner['exec']>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    }),
    writeFile: vi.fn<CommandRunner['writeFile']>().mockResolvedValue(undefined),
    execWithStdin: vi.fn<CommandRunner['execWithStdin']>().mockResolvedValue({
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

    it('new-session carries the raw name, cwd, 200x50 size, a literal PATH via -e, and no post-create options', async () => {
      primeExec(REF_OUT);
      await tmux.createSession('kk-dev-1', '/home/user/code');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('tmux new-session -d');
      expect(cmd).toContain("-s 'kk-dev-1'");
      expect(cmd).toContain("-c '/home/user/code'");
      expect(cmd).toContain('-x 200');
      expect(cmd).toContain('-y 50');
      expect(cmd).toContain(
        "-e 'PATH=/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'",
      );
      expect(cmd).not.toContain('$PATH');
      // post-create options live in buildFreshSession so a failed create rolls back cleanly
      for (const chained of ['set-option', 'mouse', 'allow-passthrough', 'extended-keys']) {
        expect(cmd).not.toContain(chained);
      }
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
  });

  describe('non-zero exits propagate tmux stderr', () => {
    const REF = { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' };
    it.each<[string, () => Promise<unknown>, string, number, RegExp]>([
      ['setServerOption', () => tmux.setServerOption('extended-keys', 'on'), 'unknown option: extended-keys', 1, /unknown option/],
      ['appendServerOptionIfMissing', () => tmux.appendServerOptionIfMissing('terminal-features', 'xterm*:extkeys'), 'tmux server not running', 1, /tmux server not running/],
      ['resizeWindowByRef', () => tmux.resizeWindowByRef(REF, 'dev-1', 80, 24), 'window not found', 1, /window not found/],
      ['probeTmuxVersion', () => TmuxManager.probeTmuxVersion(runner), 'tmux: command not found', 127, /tmux -V failed/],
    ])('%s', async (_method, invoke, stderr, exitCode, pattern) => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr, exitCode });
      await expect(invoke()).rejects.toThrow(pattern);
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

    it.each([
      ['the identity condition fails server-side (mismatched session)', { stdout: 'BX_TARGET_GONE\n', stderr: '', exitCode: 0 }],
      ['the server is gone', { stdout: '', stderr: 'no server running on /tmp/x', exitCode: 1 }],
    ])('throws PaneGoneError instead of resizing when %s', async (_label, result) => {
      runner.exec.mockResolvedValueOnce(result);
      await expect(tmux.resizeWindowByRef(REF, 'dev-1', 80, 24)).rejects.toThrow(PaneGoneError);
    });

    it('rejects non-positive or non-integer dimensions before any exec', async () => {
      await expect(tmux.resizeWindowByRef(REF, 'dev-1', 0, 24)).rejects.toThrow(/invalid dimensions/);
      await expect(tmux.resizeWindowByRef(REF, 'dev-1', 80, 24.5)).rejects.toThrow(/invalid dimensions/);
      expect(runner.exec).not.toHaveBeenCalled();
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

    it('throws on unparseable output (no version pattern)', async () => {
      primeExec('something unexpected\n');
      await expect(TmuxManager.probeTmuxVersion(runner)).rejects.toThrow(/unparseable/);
    });
  });

  describe('killSessionRef', () => {
    const REF = { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' };

    it.each<[string, Parameters<TmuxManager['killSessionRef']>[1], string[], string[]]>([
      ['equals binds the kill to the exact claim (no empty-claim escape hatch)',
        { kind: 'equals', claim: 'dev-1' }, ['#{==:#{@baxian-agent-id},dev-1}'], ['#{||:']],
      ['unclaimed adds the claim-empty condition and a session target',
        { kind: 'unclaimed' }, ['#{==:#{@baxian-agent-id},}', '#{&&:#{&&:#{==:#{pid},4242},#{==:#{start_time},1700000000}}'], []],
      ['emptyOr accepts an unclaimed session or the exact claim',
        { kind: 'emptyOr', claim: 'dev-1' }, ['#{||:#{==:#{@baxian-agent-id},},#{==:#{@baxian-agent-id},dev-1}}'], []],
    ])('%s — through a server-generation-checked if-shell, never a bare name', async (_label, policy, expected, forbidden) => {
      primeExec('');
      expect(await tmux.killSessionRef(REF, policy)).toBe('killed');
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '$7' -F");
      expect(cmd).toContain('#{&&:#{==:#{pid},4242},#{==:#{start_time},1700000000}}');
      expect(cmd).toContain(`kill-session -t '\\''$7'\\'`);
      expect(cmd).toContain('BX_KILL_REFUSED');
      for (const fragment of expected) expect(cmd).toContain(fragment);
      for (const fragment of forbidden) expect(cmd).not.toContain(fragment);
    });

    it.each<[string, Parameters<TmuxManager['killSessionRef']>[1]]>([
      ['equals', { kind: 'equals', claim: 'dev-1' }],
      ['unclaimed', { kind: 'unclaimed' }],
    ])('%s: reports refused when the by-id recheck proves the session still exists', async (_kind, policy) => {
      primeExec('BX_KILL_REFUSED\n', '');
      expect(await tmux.killSessionRef(REF, policy)).toBe('refused');
      expect(lastCmd(runner)).toBe("tmux has-session -t '$7'");
    });

    it('skips the recheck when the kill succeeds (single tmux call)', async () => {
      primeExec('');
      expect(await tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' })).toBe('killed');
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it.each<[string, string[], string, Parameters<TmuxManager['killSessionRef']>[1]]>([
      ['a REFUSED marker followed by a vanished session on recheck (tmux >= 3.6 silently accepts a missing target)',
        ['BX_KILL_REFUSED\n'], "can't find session: $7", { kind: 'equals', claim: 'dev-1' }],
      ['a REFUSED marker followed by a dead server on recheck',
        ['BX_KILL_REFUSED\n'], 'no server running on /tmp/tmux-501/default', { kind: 'unclaimed' }],
      ['a vanished session (idempotent)', [], "can't find session: $7", { kind: 'equals', claim: 'dev-1' }],
      ['a dead server', [], 'no server running on /tmp/tmux-501/default', { kind: 'equals', claim: 'dev-1' }],
    ])('reports absent for %s', async (_label, primed, stderr, policy) => {
      primeExec(...primed);
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr, exitCode: 1 });
      expect(await tmux.killSessionRef(REF, policy)).toBe('absent');
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

    it('throws on an ssh-layer failure instead of guessing', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'ssh: connect: connection refused', exitCode: 255 });
      await expect(tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' }))
        .rejects.toBeInstanceOf(TmuxOutcomeUnknownError);
    });

    it.each<[string, Parameters<TmuxManager['killSessionRef']>[0], Parameters<TmuxManager['killSessionRef']>[1], RegExp]>([
      ['a malformed ref (defense against credential corruption)',
        { sessionId: 'dev', serverPid: '1', serverStart: '2' }, { kind: 'unclaimed' }, /malformed session ref/],
      ['a claim that could alter tmux filter syntax', REF, { kind: 'equals', claim: 'a,b}' }, /unsupported characters/],
    ])('refuses to run with %s before any exec', async (_label, ref, policy, pattern) => {
      await expect(tmux.killSessionRef(ref, policy)).rejects.toThrow(pattern);
      expect(runner.exec).not.toHaveBeenCalled();
    });
  });

  describe('createSession credential', () => {
    it('returns the generation-bound ref printed atomically by -PF and injects the creation nonce via -e', async () => {
      primeExec('4242|1700000000|$12\n');
      expect(await tmux.createSession('dev', '/wt')).toEqual({
        serverPid: '4242', serverStart: '1700000000', sessionId: '$12',
      });
      expect(lastCmd(runner)).toContain("-PF '#{pid}|#{start_time}|#{session_id}'");
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
      // the caller gets a normal ref: the warning is the only trace that a transport fault was reconciled
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/createSession dev.*reconciled after uncertain outcome/));
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
      // the caller gets a normal ref: the warning is the only trace that a transport fault was reconciled
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/createSession dev.*reconciled after uncertain outcome/));
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

    it.each([
      ['no session matches', { stdout: '', stderr: '', exitCode: 0 }],
      ['the server is not running', { stdout: '', stderr: 'no server running on /tmp/tmux-501/default', exitCode: 1 }],
    ])('returns null when %s', async (_label, result) => {
      runner.exec.mockResolvedValueOnce(result);
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

    it.each([
      ['the identity condition fails (reports gone instead of configuring a fallback session)', { stdout: 'BX_TARGET_GONE\n', stderr: '', exitCode: 0 }],
      ['the server is dead', { stdout: '', stderr: 'no server running on /tmp/x', exitCode: 1 }],
    ])('reports gone when %s', async (_label, result) => {
      runner.exec.mockResolvedValueOnce(result);
      expect(await tmux.setSessionOptionsIfAlive(REF, [['mouse', 'on']], { expectedClaim: 'dev-1' })).toBe('gone');
    });

    it.each<[string, Array<[string, string]>, string]>([
      ['an option value tmux quoting cannot hold (newline)', [['@k', 'a\nb']], 'dev-1'],
      ['an expectedClaim that could alter tmux filter syntax', [['mouse', 'on']], 'a,b}'],
    ])('rejects %s before any exec', async (_label, options, expectedClaim) => {
      await expect(tmux.setSessionOptionsIfAlive(REF, options, { expectedClaim })).rejects.toThrow(/unsupported characters/);
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
      expect(cmd).toContain('#{==:#{session_id},$1}');
    });

    it('throws PaneGoneError when the identity condition fails server-side', async () => {
      primeExec('BX_TARGET_GONE\n');
      await expect(tmux.displayMessage(PANE, '#{pane_current_command}')).rejects.toThrow(PaneGoneError);
    });

    it('returns a header whose line landed in full even when the SSH transport exits 255 afterwards: the server already answered', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: okHeader('codex'), stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 });
      expect(await tmux.displayMessage(PANE, '#{pane_current_command}')).toBe('codex');
    });

    it('does not trust a header line cut off before its newline under exit 255', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'BX_PANE_OKcod', stderr: 'Connection reset by peer', exitCode: 255 });
      await expect(tmux.displayMessage(PANE, '#{pane_current_command}')).rejects.toThrow(/guarded read of %7 failed \(exit 255\)/);
    });

    it('a non-transient failure with a header line is still a failure', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: okHeader('codex'), stderr: 'usage: if-shell', exitCode: 1 });
      await expect(tmux.displayMessage(PANE, '#{pane_current_command}')).rejects.toThrow(/guarded read of %7 failed \(exit 1\)/);
    });

    it('rejects formats that could break out of tmux quoting or be eaten by strftime', async () => {
      await expect(tmux.displayMessage(PANE, "#{pane_title}'")).rejects.toThrow(/unsupported characters/);
      await expect(tmux.displayMessage(PANE, '#{==:#{pane_id},%7}')).rejects.toThrow(/unsupported characters/);
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

    it.each([
      ['the identity condition fails', { stdout: 'BX_TARGET_GONE\n', stderr: '', exitCode: 0 }],
      ['the server is gone', { stdout: '', stderr: 'no server running on /tmp/x', exitCode: 1 }],
    ])('throws PaneGoneError when %s', async (_label, result) => {
      runner.exec.mockResolvedValueOnce(result);
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

    it.each([
      ['the pane identity was recycled (never types into a recycled pane)', { stdout: 'BX_TARGET_GONE\n', stderr: '', exitCode: 0 }],
      ['the session/server is gone', { stdout: '', stderr: "can't find session: $1", exitCode: 1 }],
    ])('throws PaneGoneError when %s', async (_label, result) => {
      runner.exec.mockResolvedValueOnce(result);
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

    it('with a runtime, Enter is queued only when the server sees that runtime in the foreground', async () => {
      primeExec('BX_RUNTIME_OK\n');
      await tmux.sendEnter(PANE, 'codex');
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '%7' -F");
      expect(cmd).toContain('#{==:#{session_id},$1}');
      expect(cmd).toContain('#{||:#{==:#{pane_current_command},codex},#{==:#{pane_current_command},node}}');
      expect(cmd).not.toContain('zsh');
      expect(cmd).toContain("send-keys -t %7 -- '\\''Enter'\\'' ; display-message -p BX_RUNTIME_OK");
      expect(cmd).toContain('BX_RUNTIME_REFUSED|');
    });

    it('with a runtime, a shell foreground refuses the Enter as ReplNotReadyError', async () => {
      primeExec('BX_RUNTIME_REFUSED|1|zsh\n');
      const err = await tmux.sendEnter(PANE, 'codex').catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(true);
      expect((err as Error).message).toMatch(/pane foreground is "zsh", a shell, not codex; Enter withheld/);
    });

    it('with a runtime, a foreign non-shell foreground (an editor or pager holding the tty) refuses the Enter without the shell classification', async () => {
      primeExec('BX_RUNTIME_REFUSED|1|vim\n');
      const err = await tmux.sendEnter(PANE, 'codex').catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(false);
      expect((err as Error).message).toMatch(/pane foreground is "vim", not codex; Enter withheld/);
    });

    it('with a runtime, a lost identity is PaneGoneError and a shell-refused literal is ReplNotReadyError', async () => {
      primeExec('BX_RUNTIME_REFUSED|0|zsh\n', 'BX_RUNTIME_REFUSED|1|fish\n');
      await expect(tmux.sendEnter(PANE, 'codex')).rejects.toThrow(PaneGoneError);
      await expect(tmux.sendKeysLiteral(PANE, '/compact', 'codex')).rejects.toThrow(/the text "\/compact" withheld/);
    });
  });

  describe('runtime foreground condition (REPL_PROC_TITLES evaluated by the tmux server)', () => {
    const RUNTIMES = ['claude-code', 'codex', 'opencode', 'qodercli'] as const;
    const HAND_PICKED = [
      'claude', 'claude.exe', '2.1.26', '0.153.4', '12.345.6789', 'codex', 'node', 'opencode', 'qodercli', 'qodercli-1.2.3', 'qodercli-1',
      'zsh', 'bash', 'fish', 'pwsh', 'vim', 'git', 'python3', 'less', 'ssh', 'node.exe', 'claude-helper', 'claude.exe.bak',
      'qodercli-helper', '1.2.3-helper', '1.foo.2.bar.3evil', 'qodercli-', 'qodercli-1a', '1.2', '.1.2', '1.2.', '1..2.3', 'a1.2.3', '1.2.3.4', '',
    ];
    // 小字母表上的全部短串,前面再拼上 qodercli 前缀:通配边界(点的个数、位置、非数字字符)都在这张表里
    const ALPHABET = ['1', '.', '-', 'a'];
    const generated = (): string[] => {
      let words = [''];
      const out: string[] = [];
      for (let len = 0; len <= 4; len++) {
        out.push(...words);
        words = words.flatMap(word => ALPHABET.map(ch => word + ch));
      }
      return out;
    };
    const CORPUS = [...new Set([...HAND_PICKED, ...generated(), ...generated().map(w => `qodercli-${w}`), ...generated().map(w => `qodercli${w}`)])];

    const condFor = async (runtime: (typeof RUNTIMES)[number]): Promise<{ command: string; cond: string }> => {
      primeExec('BX_RUNTIME_OK\n');
      await tmux.sendEnter(PANE, runtime);
      const command = lastCmd(runner);
      return { command, cond: /-F '([^']*)'/.exec(command)![1] };
    };

    it.each(RUNTIMES)('%s: the server condition and hasReplProcTitle agree on every title of the corpus, with no negated shell list', async (runtime) => {
      const { command, cond } = await condFor(runtime);
      expect(cond).not.toContain('zsh');
      expect(CORPUS.length).toBeGreaterThan(900);
      const disagreements = CORPUS.filter(title => foregroundCondAccepts(command, title) !== hasReplProcTitle(title, runtime));
      expect(disagreements).toEqual([]);
    });

    it.each([
      ['qodercli', 'qodercli-helper'],
      ['claude-code', '1.2.3-helper'],
      ['claude-code', '1.foo.2.bar.3evil'],
      ['qodercli', 'qodercli-'],
      ['claude-code', '1.2.3.4'],
    ] as const)('%s: "%s" is refused by both tables (fnmatch * must not widen the version shapes)', async (runtime, title) => {
      const { command } = await condFor(runtime);
      expect(hasReplProcTitle(title, runtime)).toBe(false);
      expect(foregroundCondAccepts(command, title)).toBe(false);
    });

    it.each([
      ['claude-code', '2.1.26'],
      ['claude-code', '0.153.4'],
      ['qodercli', 'qodercli-1.2.3'],
      ['codex', 'node'],
    ] as const)('%s: "%s" is accepted by both tables', async (runtime, title) => {
      const { command } = await condFor(runtime);
      expect(hasReplProcTitle(title, runtime)).toBe(true);
      expect(foregroundCondAccepts(command, title)).toBe(true);
    });
  });

  describe('submitToRuntime (one guarded command for the text and its Enter)', () => {
    it('queues the literal and the Enter in a single runtime-guarded tmux command, literal first', async () => {
      primeExec('BX_RUNTIME_OK\n');
      await tmux.submitToRuntime(PANE, 'claude-code', '/exit');
      expect(runner.exec).toHaveBeenCalledTimes(1);
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '%7' -F");
      expect(cmd).toContain('#{==:#{pane_current_command},claude}');
      expect(cmd).toContain("send-keys -l -t %7 -- '\\''/exit'\\'' ; send-keys -t %7 -- '\\''Enter'\\'' ; display-message -p BX_RUNTIME_OK");
    });

    it('a shell foreground refuses the whole line as a shellForeground ReplNotReadyError; nothing is typed', async () => {
      primeExec('BX_RUNTIME_REFUSED|1|zsh\n');
      const err = await tmux.submitToRuntime(PANE, 'codex', '/quit').catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(true);
      expect((err as Error).message).toMatch(/pane foreground is "zsh", a shell, not codex; the line "\/quit" and Enter withheld/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('a foreign non-shell foreground refuses the line without the shell classification', async () => {
      primeExec('BX_RUNTIME_REFUSED|1|vim\n');
      const err = await tmux.submitToRuntime(PANE, 'codex', '/quit').catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(false);
      expect((err as Error).message).toMatch(/pane foreground is "vim", not codex; the line "\/quit" and Enter withheld/);
    });
  });

  describe('clearComposerDraft (dirty-then-C-c: safe on empty and drafted composers)', () => {
    const CODEX_EMPTY = 'permissions: YOLO mode\n\n› Ask Codex to do anything\n\n  gpt-5 · ~/repo';
    const CODEX_DIRTY = 'permissions: YOLO mode\n\n›\n\n  gpt-5 · ~/repo';
    const cmdsSent = (): string[] => runner.exec.mock.calls.map(c => String(c[0]));

    it('claude-code: injects a literal space, settles, then C-c without reading the screen', async () => {
      await tmux.clearComposerDraft(PANE, 'claude-code');
      const cmds = cmdsSent();
      expect(cmds).toHaveLength(2);
      expect(cmds[0]).toContain('send-keys -l -t %7');
      expect(cmds[0]).toContain("' '");
      expect(cmds[1]).toContain('send-keys -t %7');
      expect(cmds[1]).toContain("'C-c'");
      expect(cmds[1]).not.toContain('send-keys -l');
    });

    it('propagates failure when the space injection fails (no blind C-c on unknown composer)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'no such pane', exitCode: 1 });
      await expect(tmux.clearComposerDraft(PANE, 'claude-code')).rejects.toThrow(/guarded write/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('stops before C-c when the pane identity is gone', async () => {
      primeExec('BX_TARGET_GONE\n');
      await expect(tmux.clearComposerDraft(PANE, 'codex')).rejects.toThrow(PaneGoneError);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    const cursorReads = (): string[] => cmdsSent().filter(c => c.includes('cursor_x'));
    const captures = (): string[] => cmdsSent().filter(c => c.includes('capture-pane'));
    const COMMA = "send-keys -l -t %7 -- '\\'','\\''";
    const dirtyKeys = (): string[] => cmdsSent().filter(c => c.includes(COMMA));
    // 帧只随已发出的弄脏键数变化:columns[k] / foregrounds[k] 是发出 k 个键后读到的光标列与前台进程,首项为基线
    const scriptCursor = (columns: string[], screen = CODEX_EMPTY, foregrounds: string[] = ['codex']): void => {
      let keys = 0;
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes(COMMA)) keys += 1;
        if (cmd.includes('cursor_x')) {
          const column = columns[Math.min(keys, columns.length - 1)];
          const foreground = foregrounds[Math.min(keys, foregrounds.length - 1)];
          return { stdout: okHeader(`${column}|${foreground}`), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) return { stdout: okBody(screen), stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      });
    };

    it('codex: types a comma (not a space) and sends C-c once the cursor column changed, without reading the screen', async () => {
      scriptCursor(['2', '3']);
      await tmux.clearComposerDraft(PANE, 'codex', { intervalMs: 50 });
      const cmds = cmdsSent();
      expect(cmds[0]).toContain('cursor_x');
      expect(cmds[1]).toContain(COMMA);
      expect(cmds[cmds.length - 1]).toContain("'C-c'");
      expect(cmds[cmds.length - 1]).toContain('BX_RUNTIME_OK');
      expect(cmds[1]).toContain('BX_RUNTIME_OK');
      expect(dirtyKeys()).toHaveLength(1);
      expect(cursorReads()).toHaveLength(2);
      expect(captures()).toHaveLength(0);
    });

    // 前台变化落在帧读取之后、按键到达之前:客户端看不到,只能由服务端在同一条 if-shell 里拒绝
    const refuseAtServer = (columns: string[], foregrounds: string[], refuse: (cmd: string) => string | undefined): void => {
      scriptCursor(columns, CODEX_EMPTY, foregrounds);
      const scripted = runner.exec.getMockImplementation()!;
      runner.exec.mockImplementation(async (cmd: string) => {
        const refusal = refuse(cmd);
        if (refusal) return { stdout: `${refusal}\n`, stderr: '', exitCode: 0 };
        return scripted(cmd);
      });
    };

    it('codex: the C-c after same-frame cursor evidence is refused by the server when the runtime exited to a shell in between; nothing else is typed', async () => {
      refuseAtServer(['2', '3'], ['codex'], cmd => (cmd.includes("'C-c'") && cmd.includes('BX_RUNTIME_OK') ? 'BX_RUNTIME_REFUSED|1|zsh' : undefined));
      const err = await tmux.clearComposerDraft(PANE, 'codex', { intervalMs: 50 }).catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(true);
      expect((err as Error).message).toMatch(/pane foreground is "zsh", a shell, not codex; C-c withheld/);
      const ccs = cmdsSent().filter(c => c.includes("'C-c'"));
      expect(ccs).toHaveLength(1);
      expect(ccs[0]).toContain('BX_RUNTIME_OK');
      expect(ccs[0]).not.toContain('BX_SHELL_OK');
    });

    it('codex: the dirtying key is refused by the server when the pane is a shell by the time it arrives: no C-c at all', async () => {
      refuseAtServer(['2'], ['codex'], cmd => (cmd.includes(COMMA) ? 'BX_RUNTIME_REFUSED|1|zsh' : undefined));
      const err = await tmux.clearComposerDraft(PANE, 'codex', { intervalMs: 50 }).catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as Error).message).toMatch(/the text "," withheld/);
      expect(cmdsSent().some(c => c.includes("'C-c'"))).toBe(false);
      expect(cursorReads()).toHaveLength(1);
    });

    it('codex: the stray-key discard is a shell-guarded C-c; a runtime that took the foreground again before it arrived does not receive it', async () => {
      refuseAtServer(['2', '5'], ['codex', 'zsh'], cmd => (cmd.includes("'C-c'") && cmd.includes('BX_SHELL_OK') ? 'BX_SHELL_REFUSED|1|codex' : undefined));
      const err = await tmux.clearComposerDraft(PANE, 'codex', { timeoutMs: 120, intervalMs: 50 }).catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as Error).message).toMatch(/foreground became "zsh" after the dirtying key.*a runtime took the foreground again before the stray key could be discarded, so no C-c was sent/);
      expect((err as Error).message).not.toMatch(/was discarded/);
      const ccs = cmdsSent().filter(c => c.includes("'C-c'"));
      expect(ccs).toHaveLength(1);
      expect(ccs[0]).toContain('BX_SHELL_OK');
      expect(ccs[0]).not.toContain('BX_RUNTIME_OK');
    });

    it('claude-code: the space and the C-c are runtime-guarded too; a shell foreground refuses the space before anything is typed', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'BX_RUNTIME_REFUSED|1|zsh\n', stderr: '', exitCode: 0 });
      const err = await tmux.clearComposerDraft(PANE, 'claude-code').catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as Error).message).toMatch(/the text " " withheld/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
      expect(lastCmd(runner)).toContain('BX_RUNTIME_OK');
    });

    it('codex: wrap boundary — the comma opens a new row (26 → 3), which counts as accepted', async () => {
      scriptCursor(['26', '3']);
      await tmux.clearComposerDraft(PANE, 'codex', { intervalMs: 50 });
      expect(dirtyKeys()).toHaveLength(1);
      expect(cmdsSent()[cmdsSent().length - 1]).toContain("'C-c'");
    });

    it('codex: overflowing-separator aliasing — the first comma leaves the column unchanged, the second one moves it (measured 3 → 3 → 4)', async () => {
      // 屏幕上滚入/滚出的逗号、history-limit 是否已满都不参与判定:证据只有光标列
      const scrolling = 'x, y\n› aa\n  aaaaaaaaaaaaaaaaaaaaaaa,\n\n  gpt-5';
      scriptCursor(['3', '3', '4'], scrolling);
      await tmux.clearComposerDraft(PANE, 'codex', { timeoutMs: 120, intervalMs: 50 });
      const cmds = cmdsSent();
      expect(dirtyKeys()).toHaveLength(2);
      expect(cmds[cmds.length - 1]).toContain("'C-c'");
      expect(cmds.filter(c => c.includes("'C-c'"))).toHaveLength(1);
      expect(captures()).toHaveLength(0);
      expect(cmds.some(c => c.includes('history_size'))).toBe(false);
    });

    it('codex: a key the composer never accepts (Vim Normal, modal, hung TUI) fails closed after two keys without C-c', async () => {
      scriptCursor(['2', '2', '2']);
      await expect(tmux.clearComposerDraft(PANE, 'codex', { timeoutMs: 120, intervalMs: 50 }))
        .rejects.toThrow(/2 dirtying keys "," left the cursor at column 2 \(120ms each\); C-c withheld/);
      expect(dirtyKeys()).toHaveLength(2);
      expect(cmdsSent().some(c => c.includes("'C-c'"))).toBe(false);
      expect(cursorReads().length).toBeGreaterThanOrEqual(5);
    });

    it.each([
      ['bare › with no placeholder', 'permissions: YOLO mode\n\n›\n\n  gpt-5 · ~/repo'],
      ['/side placeholder', 'permissions: YOLO mode\n\n› Ask a follow-up question\n\n  gpt-5 · ~/repo'],
      ['placeholder truncated by a narrow pane', '› Ask Codex to\n\n  gpt-5'],
      ['default placeholder', CODEX_EMPTY],
      ['commas already on screen', 'a, b, c\n› \n\n  gpt-5'],
      ['a Vim Normal composer that swallowed the key', 'permissions: YOLO mode\n\n› \n\n  -- NORMAL --  gpt-5'],
    ])('codex: screen text is never evidence — withholds C-c while the cursor stays put even though the screen shows %s', async (_label, screen) => {
      scriptCursor(['2'], screen);
      await expect(tmux.clearComposerDraft(PANE, 'codex', { timeoutMs: 120, intervalMs: 50 }))
        .rejects.toThrow(ReplNotReadyError);
      expect(cmdsSent().some(c => c.includes("'C-c'"))).toBe(false);
      expect(captures()).toHaveLength(1);
    });

    it('codex: the timeout error carries the screen captured once, after the last key, for diagnosis', async () => {
      scriptCursor(['2'], CODEX_DIRTY);
      const err = await tmux.clearComposerDraft(PANE, 'codex', { timeoutMs: 60, intervalMs: 50 }).catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).lastScreen).toBe(CODEX_DIRTY);
      const cmds = cmdsSent();
      expect(captures()).toHaveLength(1);
      expect(cmds.indexOf(captures()[0])).toBeGreaterThan(cmds.lastIndexOf(dirtyKeys()[0]));
    });

    it('codex: the cursor column and the foreground process are read in the same tmux frame', async () => {
      scriptCursor(['2', '3']);
      await tmux.clearComposerDraft(PANE, 'codex', { intervalMs: 50 });
      expect(cursorReads()).toHaveLength(2);
      for (const read of cursorReads()) expect(read).toContain('#{cursor_x}|#{pane_current_command}');
    });

    it('codex: node as the foreground title is still the runtime (codex launches through node on some installs)', async () => {
      scriptCursor(['2', '3'], CODEX_EMPTY, ['node']);
      await tmux.clearComposerDraft(PANE, 'codex', { intervalMs: 50 });
      expect(cmdsSent()[cmdsSent().length - 1]).toContain("'C-c'");
    });

    it('codex: refuses to type anything when the pane is already at a shell prompt', async () => {
      scriptCursor(['2'], CODEX_EMPTY, ['zsh']);
      const err = await tmux.clearComposerDraft(PANE, 'codex', { intervalMs: 50 }).catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as Error).message).toMatch(/pane foreground is "zsh", not codex; nothing typed and C-c withheld/);
      expect(cmdsSent().some(c => c.includes('send-keys'))).toBe(false);
      expect(captures()).toHaveLength(1);
    });

    it.each([
      ['a different column', ['2', '5']],
      ['the same column', ['2', '2']],
    ])('codex: a shell prompt that replaces the runtime during the dirtying wait at %s is not composer evidence — no success, the stray comma is discarded on the shell', async (_label, columns) => {
      scriptCursor(columns, CODEX_EMPTY, ['codex', 'zsh']);
      const err = await tmux.clearComposerDraft(PANE, 'codex', { timeoutMs: 120, intervalMs: 50 }).catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as Error).message).toMatch(/foreground became "zsh" after the dirtying key.*stray key was discarded with C-c on the shell/);
      expect(dirtyKeys()).toHaveLength(1);
      const cmds = cmdsSent();
      const ccs = cmds.filter(c => c.includes("'C-c'"));
      expect(ccs).toHaveLength(1);
      expect(cmds.indexOf(ccs[0])).toBeGreaterThan(cmds.indexOf(dirtyKeys()[0]));
    });

    it('codex: a foreground that is neither the runtime nor a shell gets no C-c at all', async () => {
      scriptCursor(['2', '7'], CODEX_EMPTY, ['codex', 'vim']);
      const err = await tmux.clearComposerDraft(PANE, 'codex', { timeoutMs: 120, intervalMs: 50 }).catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as Error).message).toMatch(/foreground became "vim" after the dirtying key; the cursor move is not composer evidence/);
      expect((err as Error).message).not.toMatch(/discarded/);
      expect(dirtyKeys()).toHaveLength(1);
      expect(cmdsSent().some(c => c.includes("'C-c'"))).toBe(false);
    });
  });

  describe('submitCommandOnShell (shell check and keys in one server-side if-shell)', () => {
    const LAUNCH = "cd '/tmp/repo' && codex --yolo";
    const NONCE_RE = /@bx_shell_write ([0-9a-f-]{36})/;
    const nonceOf = (cmd: string): string => NONCE_RE.exec(cmd)![1];
    const transport255: ExecResult = { stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 };

    it('queues the nonce, C-c, the literal command and Enter behind a condition that requires pane identity and a shell foreground, in one tmux call', async () => {
      primeExec('BX_SHELL_OK\n');
      await tmux.submitCommandOnShell(PANE, LAUNCH);
      expect(runner.exec).toHaveBeenCalledTimes(1);
      const cmd = lastCmd(runner);
      expect(cmd).toContain("tmux if-shell -t '%7' -F");
      expect(cmd).toContain('#{==:#{session_id},$1}');
      expect(cmd).toContain('#{==:#{@baxian-agent-id},');
      for (const shell of ['zsh', 'bash', 'sh', 'fish', 'dash', 'pwsh']) {
        expect(cmd).toContain(`#{==:#{pane_current_command},${shell}}`);
      }
      const order = [`set-option -t %7 @bx_shell_write ${nonceOf(cmd)}`, 'C-c', 'codex --yolo', 'Enter', 'BX_SHELL_OK']
        .map(part => cmd.indexOf(part));
      expect(order.every(i => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(cmd).toContain('BX_SHELL_REFUSED|');
      expect(cmd.indexOf('BX_SHELL_REFUSED')).toBeGreaterThan(cmd.indexOf('BX_SHELL_OK'));
    });

    it('uses a fresh nonce per call', async () => {
      primeExec('BX_SHELL_OK\n', 'BX_SHELL_OK\n');
      await tmux.submitCommandOnShell(PANE, LAUNCH);
      await tmux.submitCommandOnShell(PANE, LAUNCH);
      const [first, second] = runner.exec.mock.calls.map(call => nonceOf(String(call[0])));
      expect(first).not.toBe(second);
    });

    it('refuses without any keystroke when tmux reports a non-shell foreground, naming the process', async () => {
      primeExec('BX_SHELL_REFUSED|1|codex\n');
      await expect(tmux.submitCommandOnShell(PANE, LAUNCH))
        .rejects.toThrow(/pane %7 foreground is "codex", not a shell; C-c, command and Enter withheld/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('reports a lost pane identity as PaneGoneError, not as a foreground problem', async () => {
      primeExec('BX_SHELL_REFUSED|0|zsh\n');
      await expect(tmux.submitCommandOnShell(PANE, LAUNCH)).rejects.toThrow(PaneGoneError);
    });

    it('maps a vanished session to PaneGoneError', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: "can't find session: $1", exitCode: 1 });
      await expect(tmux.submitCommandOnShell(PANE, LAUNCH)).rejects.toThrow(PaneGoneError);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('a received OK marker is success even when the SSH transport exits 255 afterwards: the server already ran the queue', async () => {
      runner.exec.mockResolvedValueOnce({ ...transport255, stdout: 'BX_SHELL_OK\n' });
      await expect(tmux.submitCommandOnShell(PANE, LAUNCH)).resolves.toBeUndefined();
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('a received REFUSED marker with exit 255 is still a refusal, not a transport failure', async () => {
      runner.exec.mockResolvedValueOnce({ ...transport255, stdout: 'BX_SHELL_REFUSED|1|codex\n' });
      await expect(tmux.submitCommandOnShell(PANE, LAUNCH)).rejects.toThrow(/foreground is "codex", not a shell/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('an exec rejection is reconciled by reading the nonce back under the pane identity: a match means the keys were queued', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      runner.exec.mockRejectedValueOnce(new Error('Command timed out after 5000ms'));
      runner.exec.mockImplementationOnce(async () => ({
        stdout: okHeader(nonceOf(String(runner.exec.mock.calls[0][0]))), stderr: '', exitCode: 0,
      }));
      await expect(tmux.submitCommandOnShell(PANE, LAUNCH)).resolves.toBeUndefined();
      expect(runner.exec).toHaveBeenCalledTimes(2);
      const probe = lastCmd(runner);
      expect(probe).toContain("tmux if-shell -t '%7' -F");
      expect(probe).toContain('#{==:#{@baxian-agent-id},');
      expect(probe).toContain('display-message -p -t %7 ');
      expect(probe).toContain('BX_PANE_OK#{@bx_shell_write}');
      expect(probe).not.toContain('send-keys');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(
        /reconciled as executed after an uncertain result \(exec rejected: Command timed out after 5000ms\)/,
      ));
      warn.mockRestore();
    });

    it('a marker-less exit 255 whose nonce probe reads another value means nothing was typed: a plain failure, not outcome unknown', async () => {
      runner.exec.mockResolvedValueOnce(transport255);
      runner.exec.mockResolvedValueOnce({ stdout: okHeader('nonce-of-an-earlier-write'), stderr: '', exitCode: 0 });
      const err = await tmux.submitCommandOnShell(PANE, LAUNCH).catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TmuxOutcomeUnknownError);
      expect((err as Error).message).toMatch(/did not reach the tmux server \(neither marker returned \(exit 255\)/);
      expect((err as Error).message).toMatch(/nothing was typed/);
      expect(runner.exec).toHaveBeenCalledTimes(2);
    });

    it('a marker-less exit 0 is not trusted either: the nonce decides', async () => {
      primeExec('', okHeader(''));
      await expect(tmux.submitCommandOnShell(PANE, LAUNCH)).rejects.toThrow(/nothing was typed/);
      expect(runner.exec).toHaveBeenCalledTimes(2);
    });

    it('reports outcome unknown when the nonce probe fails too, instead of a plain failure', async () => {
      runner.exec.mockResolvedValueOnce(transport255);
      runner.exec.mockResolvedValueOnce(transport255);
      const err = await tmux.submitCommandOnShell(PANE, LAUNCH).catch(e => e);
      expect(err).toBeInstanceOf(TmuxOutcomeUnknownError);
      expect((err as Error).message).toMatch(/outcome unknown \(neither marker returned \(exit 255\)/);
      expect((err as Error).message).toMatch(/inspect the pane before retrying/);
    });

    it('a nonce probe whose BX_PANE_OK line landed before the transport exited 255 still proves the write: reconciled as executed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      runner.exec.mockResolvedValueOnce(transport255);
      runner.exec.mockImplementationOnce(async () => ({
        ...transport255, stdout: okHeader(nonceOf(String(runner.exec.mock.calls[0][0]))),
      }));
      await expect(tmux.submitCommandOnShell(PANE, LAUNCH)).resolves.toBeUndefined();
      expect(runner.exec).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reconciled as executed after an uncertain result \(neither marker returned \(exit 255\)/));
      warn.mockRestore();
    });

    it('a nonce line cut off before its newline under exit 255 is evidence of nothing: outcome unknown, never "nothing was typed"', async () => {
      runner.exec.mockResolvedValueOnce(transport255);
      runner.exec.mockImplementationOnce(async () => ({
        ...transport255, stdout: `BX_PANE_OK${nonceOf(String(runner.exec.mock.calls[0][0])).slice(0, 20)}`,
      }));
      const err = await tmux.submitCommandOnShell(PANE, LAUNCH).catch(e => e);
      expect(err).toBeInstanceOf(TmuxOutcomeUnknownError);
      expect((err as Error).message).not.toMatch(/nothing was typed/);
    });

    it('a pane whose identity is gone by the time of the nonce probe is PaneGoneError', async () => {
      runner.exec.mockResolvedValueOnce(transport255);
      runner.exec.mockResolvedValueOnce({ stdout: 'BX_TARGET_GONE\n', stderr: '', exitCode: 0 });
      await expect(tmux.submitCommandOnShell(PANE, LAUNCH)).rejects.toThrow(PaneGoneError);
    });

    it('a definite non-transient failure is reported as such without a nonce probe', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'usage: if-shell [-bF] [-t target-pane] shell-command command [command]', exitCode: 1 });
      await expect(tmux.submitCommandOnShell(PANE, LAUNCH)).rejects.toThrow(/shell-guarded write to %7 failed \(exit 1\)/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('waitReplReady with runtimeSeen (the caller has just seen the runtime in the foreground)', () => {
    it('a shell on the very first sample fails fast instead of polling to the deadline', async () => {
      primeExec(okHeader('zsh'));
      const started = Date.now();
      const err = await tmux.waitReplReady(PANE, 'claude-code', { failFastOnShell: true, runtimeSeen: true, timeoutMs: 5_000, intervalMs: 50 }).catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('without runtimeSeen a first-sample shell still gets the whole window: a launch hook may not have exec-ed the runtime yet', async () => {
      runner.exec.mockImplementation(async (cmd: string) => (cmd.includes('capture-pane')
        ? { stdout: okBody('$ '), stderr: '', exitCode: 0 }
        : { stdout: okHeader('zsh'), stderr: '', exitCode: 0 }));
      const err = await tmux.waitReplReady(PANE, 'claude-code', { failFastOnShell: true, timeoutMs: 120, intervalMs: 50 }).catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as Error).message).toMatch(/at deadline/);
      expect(runner.exec.mock.calls.length).toBeGreaterThan(2);
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

    it.each<[string, Parameters<TmuxManager['capturePaneById']>[1], RegExp[]]>([
      ['opts.ansi=true adds -e (ANSI escape passthrough)', { ansi: true }, [/(^|\s)-e(\s|$)/]],
      ['opts.scrollback>0 adds -S -<n>', { scrollback: 2000 }, [/-S/, /-2000/]],
    ])('%s', async (_label, opts, patterns) => {
      primeExec(okBody(''));
      await tmux.capturePaneById(PANE, opts);
      const cmd = lastCmd(runner);
      for (const pattern of patterns) expect(cmd).toMatch(pattern);
    });

    it('a body read under exit 255 fails even with the header landed: the body may have been cut short', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: okBody('content\n'), stderr: 'Connection reset by peer', exitCode: 255 });
      await expect(tmux.capturePaneById(PANE)).rejects.toThrow(/guarded read of %7 failed \(exit 255\)/);
    });

    it('throws PaneGoneError when the identity condition fails', async () => {
      primeExec('BX_TARGET_GONE\n');
      await expect(tmux.capturePaneById(PANE)).rejects.toThrow(PaneGoneError);
    });
  });

  describe('injectPrompt (probe-gated stdin load → claim-checked paste-or-self-clean)', () => {
    const stdinMock = (r: typeof runner): StdinMock => r.execWithStdin;

    it('loads via probe-gated stdin (no openssl), then a separate guarded paste', async () => {
      await tmux.injectPrompt(PANE, 'hello world', 'dev-1', 'claude-code');
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
      expect(pasteCmd).toContain('BX_RUNTIME_OK');
      expect(pasteCmd).toContain('BX_RUNTIME_REFUSED|');
      expect(pasteCmd).toContain('#{||:#{==:#{pane_current_command},claude},#{||:#{==:#{pane_current_command},claude.exe},#{&&:#{m:*.*.*,#{pane_current_command}},');
      expect(pasteCmd).toContain('#{?#{m:*[!0-9.]*,#{pane_current_command}},0,1}');
      expect(pasteCmd).not.toContain('zsh');
      expect(pasteCmd).toMatch(/baxian-dev-1-[0-9a-f-]{36}/);
    });

    it('probe-gates the load: the five-field identity test precedes load-buffer in the load command', async () => {
      await tmux.injectPrompt(PANE, 'x', 'dev-1', 'claude-code');
      const loadCmd = stdinMock(runner).mock.calls[0][0] as string;
      expect(loadCmd).toContain('#{pid}|#{start_time}|#{session_id}|#{pane_id}|#{@baxian-agent-id}');
      expect(loadCmd).toContain("'4242|1700000000|$1|%7|dev-1'");
      expect(loadCmd.indexOf('display-message')).toBeLessThan(loadCmd.indexOf('load-buffer'));
    });

    it('throws PaneGoneError when the identity probe fails before load (no buffer, no reconcile)', async () => {
      stdinMock(runner).mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
      await expect(tmux.injectPrompt(PANE, 'x', 'dev-1', 'claude-code')).rejects.toThrow(/before any buffer was created/);
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('throws PaneGoneError when the paste-time identity condition fails (buffer self-cleaned server-side)', async () => {
      primeExec('BX_RUNTIME_REFUSED|0|claude\n');
      await expect(tmux.injectPrompt(PANE, 'x', 'dev-1', 'claude-code')).rejects.toThrow(PaneGoneError);
      expect(lastCmd(runner)).toContain('delete-buffer');
    });

    it('refuses the paste server-side when the foreground has become a shell: ReplNotReadyError, buffer self-cleaned, no extra round trip', async () => {
      primeExec('BX_RUNTIME_REFUSED|1|zsh\n');
      const err = await tmux.injectPrompt(PANE, 'rm -rf / # a prompt, not a command', 'dev-1', 'codex').catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(true);
      expect((err as Error).message).toMatch(/pane foreground is "zsh", a shell, not codex; prompt paste withheld \(buffer self-cleaned\)/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('refuses the paste server-side when a non-shell foreign process owns the pane: not classified as a shell foreground', async () => {
      primeExec('BX_RUNTIME_REFUSED|1|less\n');
      const err = await tmux.injectPrompt(PANE, 'a prompt', 'dev-1', 'claude-code').catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(false);
      expect((err as Error).message).toMatch(/pane foreground is "less", not claude-code; prompt paste withheld \(buffer self-cleaned\)/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('a paste whose OK marker landed before the transport exited 255 is a success', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'BX_RUNTIME_OK\n', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 });
      await expect(tmux.injectPrompt(PANE, 'x', 'dev-1', 'claude-code')).resolves.toBeUndefined();
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it.each<[string, () => void, RegExp | typeof PaneGoneError, number]>([
      ['the pane vanishes AFTER load (paste exit 1, can\'t find pane)', () => {
        runner.exec.mockResolvedValueOnce({ stdout: '', stderr: "can't find pane: %7", exitCode: 1 });
        primeExec('');
      }, PaneGoneError, 2],
      ['the load outcome is unknown (exit 255)', () => {
        stdinMock(runner).mockResolvedValueOnce({ stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 });
        primeExec('');
      }, /load outcome unknown/, 1],
      ['the paste exits non-zero', () => {
        runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'paste boom', exitCode: 5 });
        primeExec('');
      }, /paste failed/, 2],
    ])('reconciles the loaded buffer by unique name, then rejects, when %s', async (_label, prime, expected, execCalls) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prime();
      await expect(tmux.injectPrompt(PANE, 'x', 'dev-1', 'claude-code')).rejects.toThrow(expected);
      expect(runner.exec).toHaveBeenCalledTimes(execCalls);
      const deleteCmd = lastCmd(runner);
      expect(deleteCmd).toContain('tmux delete-buffer -b');
      expect(deleteCmd).toMatch(/baxian-dev-1-[0-9a-f-]{36}/);
      warn.mockRestore();
    });

    it('accepts a prompt at exactly 80KB (boundary inside the cap)', async () => {
      const cap = 80 * 1024;
      const prompt = 'x'.repeat(cap);
      await expect(tmux.injectPrompt(PANE, prompt, 'dev-1', 'claude-code')).resolves.toBeUndefined();
      expect(stdinMock(runner)).toHaveBeenCalledTimes(1);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('stagePromptBuffer loads via stdin (no openssl); pasteStagedBuffer pastes on the same named buffer', async () => {
      const { buf } = await tmux.stagePromptBuffer('%0', 'hello world', 'dev-1');
      expect(buf).toMatch(/^baxian-dev-1-[0-9a-f-]{36}$/);
      await tmux.pasteStagedBuffer(PANE, buf, 'claude-code');

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
      expect(pasteCmd).toContain("tmux if-shell -t '%7'");
      expect(pasteCmd).toContain(`paste-buffer -b ${buf} -t %7 -d -p -r`);
      expect(pasteCmd).toContain('BX_RUNTIME_OK');
      expect(pasteCmd).toContain('#{==:#{@baxian-agent-id},dev-1}');
    });

    it('pasteStagedBuffer is refused server-side on a shell foreground and leaves the buffer for the caller to drop', async () => {
      primeExec('BX_RUNTIME_REFUSED|1|bash\n');
      const err = await tmux.pasteStagedBuffer(PANE, 'baxian-dev-1-buf', 'claude-code').catch(e => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(true);
      expect((err as Error).message).toMatch(/the prompt paste withheld/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
      expect(lastCmd(runner)).not.toContain('delete-buffer');
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
      expect(err.message).toMatch(/staged buffer baxian-dev-1-[0-9a-f-]{36} may persist remotely/);
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
      // a confirmed-absent buffer is retired, never reported as a cleanup failure (the warning is the only report channel)
      expect(warn).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(expect.stringMatching(/retired staged buffer baxian-dev-1-[0-9a-f-]{36}/));
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
      // the caller only sees the transport error: the unconfirmed cleanup (buffer may persist) is reported by the warning alone
      const unconfirmed = warn.mock.calls.map(call => String(call[0])).find(msg => /may persist/.test(msg));
      expect(unconfirmed).toMatch(/baxian-dev-1-[0-9a-f-]{36}/);
      expect(unconfirmed).toMatch(/255/);
      warn.mockRestore();
    });

    it('a definite staging failure does not probe the buffer', async () => {
      stdinMock(runner).mockResolvedValueOnce({ stdout: '', stderr: 'bad option', exitCode: 1 });

      await expect(tmux.stagePromptBuffer('%0', 'prompt', 'dev-1')).rejects.toThrow(/bad option/);
      const cmds = runner.exec.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(cmds.some(cmd => cmd.includes('delete-buffer'))).toBe(false);
    });

    it.each<[string, (prompt: string) => Promise<unknown>]>([
      ['stagePromptBuffer', prompt => tmux.stagePromptBuffer('%0', prompt, 'dev-1')],
      ['injectPrompt', prompt => tmux.injectPrompt(PANE, prompt, 'dev-1', 'claude-code')],
    ])('%s rejects a prompt over 80KB before issuing any tmux command (deterministic error)', async (_entry, invoke) => {
      await expect(invoke('x'.repeat(80 * 1024 + 1))).rejects.toThrow(/prompt too large/);
      expect(runner.exec).not.toHaveBeenCalled();
      expect(stdinMock(runner)).not.toHaveBeenCalled();
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
      primeSnapshot('✻ Working… (3s · esc to interrupt)\n', 0);
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

    // fire-and-forget 的判据在调用方(粘贴前那一帧),这里只负责观察提交跃迁
    it('已判 working 的基线在这里不构成 ack —— 观察不到跃迁就超时,不谎报已提交', async () => {
      const baseline = buildBaseline('› Run /review\n  gpt-5.5 xhigh · ~/repo\n', 0);
      primeTitle('⠹ Reviewing');
      await expect(tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 200, intervalMs: 50 }))
        .rejects.toThrow(/runtime ack timeout/);
    });

    it('基线上的陈旧 working 标题同样不构成 ack(herdr: 无仲裁,标题需相对基线变化)', async () => {
      const baseline = buildBaseline('✻ Worked for 10s\n\n❯ \n', 0);
      paneTitle = '⠹ 旧任务';
      await expect(tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 200, intervalMs: 50 }))
        .rejects.toThrow(/runtime ack timeout/);
    });

    it('honors a caller-provided PRE-Enter baseline title: a title already working on the first post-submit read still acks', async () => {
      const baseline = buildBaseline('› Run /review\n  gpt-5.5 xhigh · ~/repo\n', 0);
      primeTitle('⠹ Reviewing');
      await expect(
        tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 1500, intervalMs: 50, baselineTitle: '~/repo' }),
      ).resolves.toBeUndefined();
    });

    // opencode/qodercli 的 working 规则是 whole_recent 裸 contains:提示词带上关键字,基线就自匹配
    it.each<[string, 'opencode' | 'qodercli', string]>([
      ['opencode', 'opencode', '› 帮我看下 esc to interrupt 这个判定\n'],
      ['qodercli', 'qodercli', '> 文案里写的是 (esc to cancel, 要不要改\n'],
    ])('%s: 提示词自带 working 关键字的基线不可 ack —— 走重发/超时,不能当作已提交', async (_n, runtime, pasted) => {
      const baseline = buildBaseline(pasted, 0);
      runner.exec.mockImplementation(async () => ({ stdout: composeSnapStdout(pasted, 0), stderr: '', exitCode: 0 }));
      const resend = vi.fn(async () => undefined);
      await expect(tmux.waitSubmitAck(PANE, baseline, runtime, {
        timeoutMs: 260, intervalMs: 50, baselineTitle: '', resend, resendIntervalMs: 50,
      })).rejects.toThrow(/runtime ack timeout/);
      expect(resend.mock.calls.length).toBeGreaterThan(0);
    });

    // 自匹配基线之后,「提交成功的新 working 帧」与「Enter 被吞 + attach 重绘」在屏幕上完全同形:
    // 两者都判 working、都与基线不同。只有 runtime 自己写的标题能分开,屏幕证据一律不采信。
    it.each<[string, 'opencode' | 'qodercli', string, string, string]>([
      [
        'opencode',
        'opencode',
        '› 帮我看下 esc to interrupt 这个判定\n',
        '⏳ opencode is working\n  esc to interrupt\n  ■■■■■■\n',
        '› 帮我看下 esc to interrupt 这个判定\n[Image #1] frame 0\n',
      ],
      [
        'qodercli',
        'qodercli',
        '> 文案里写的是 (esc to cancel, 要不要改\n',
        '⠹ 正在执行 (esc to cancel, 请稍候)\n',
        '> 文案里写的是 (esc to cancel, 要不要改\n[Image #1] frame 0\n',
      ],
    ])('%s: 自匹配基线后没有任何可观测的提交证据 —— 屏幕同形,标题也不构成 working 证据', async (_n, runtime, pasted, submitted, redrawn) => {
      for (const frame of [pasted, submitted, redrawn]) {
        expect(classifyScreen(runtime, frame).state, frame).toBe('working');
      }
      expect(new Set([pasted, submitted, redrawn]).size).toBe(3);
      // 这两个 runtime 的 manifest 没有 osc_title 规则:标题单独看永远不是 working 证据
      for (const title of [`${runtime} · working`, '⠹ Reviewing', '~/other/dir']) {
        expect(classifyScreen(runtime, '', title).state, title).not.toBe('working');
      }
      const baseline = buildBaseline(pasted, 0);
      const runAck = async (after: string, titleAfter: string): Promise<string> => {
        let n = 0;
        runner.exec.mockImplementation(async () => ({ stdout: composeSnapStdout(n++ === 0 ? pasted : after, 0), stderr: '', exitCode: 0 }));
        let t = 0;
        vi.spyOn(tmux, 'readPaneTitle').mockImplementation(async () => (t++ === 0 ? '' : titleAfter));
        return tmux.waitSubmitAck(PANE, baseline, runtime, { timeoutMs: 300, intervalMs: 50, baselineTitle: '' })
          .then(() => 'ack').catch(() => 'timeout');
      };
      for (const after of [submitted, redrawn]) {
        for (const title of ['', `${runtime} · working`, '~/other/dir']) {
          expect(await runAck(after, title), `${after} / ${title}`).toBe('timeout');
        }
      }
    });

    it('自匹配基线 + 无关标题变化不构成 ack —— 屏幕的 working 不能替标题作证', async () => {
      const pasted = '› 帮我看下 esc to interrupt 这个判定\n';
      const baseline = buildBaseline(pasted, 0);
      runner.exec.mockImplementation(async () => ({ stdout: composeSnapStdout(pasted, 0), stderr: '', exitCode: 0 }));
      let t = 0;
      vi.spyOn(tmux, 'readPaneTitle').mockImplementation(async () => (t++ === 0 ? '~/repo' : '~/some/other/dir'));
      await expect(tmux.waitSubmitAck(PANE, baseline, 'opencode', { timeoutMs: 300, intervalMs: 50, baselineTitle: '~/repo' }))
        .rejects.toThrow(/runtime ack timeout/);
    });

    it('claude/codex 的自匹配基线仍可由真正的 working 标题 ack(标题规则存在)', async () => {
      const pasted = '✻ 复现一下… (3s · esc to interrupt) 这段文案\n';
      const baseline = buildBaseline(pasted, 0);
      expect(classifyScreen('claude-code', pasted).state).toBe('working');
      runner.exec.mockImplementation(async () => ({ stdout: composeSnapStdout(pasted, 0), stderr: '', exitCode: 0 }));
      let t = 0;
      vi.spyOn(tmux, 'readPaneTitle').mockImplementation(async () => (t++ === 0 ? '✳ Claude Code' : '~/other/dir'));
      await expect(tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 300, intervalMs: 50, baselineTitle: '✳ Claude Code' }))
        .rejects.toThrow(/runtime ack timeout/);
      t = 0;
      vi.spyOn(tmux, 'readPaneTitle').mockImplementation(async () => (t++ === 0 ? '✳ Claude Code' : '⠂ 正在处理'));
      await expect(tmux.waitSubmitAck(PANE, baseline, 'claude-code', { timeoutMs: 300, intervalMs: 50, baselineTitle: '✳ Claude Code' }))
        .resolves.toBeUndefined();
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
      primeSnapshot('› \n• Working (2s • esc to interrupt)\n', 0);
      await expect(tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 1500, intervalMs: 50 }))
        .resolves.toBeUndefined();
    });

    it('codex: a pasted line-start "Working (8s)" is NOT the herdr • Working shape → idle baseline, swallowed Enter surfaces as ack timeout', async () => {
      const baseline = buildBaseline('→ baxian git:(main)\nPlease explain this log:\nWorking (8s)\n', 0);
      runner.exec.mockResolvedValue({ stdout: composeSnapStdout('→ baxian git:(main)\nPlease explain this log:\nWorking (8s)\n', 0), stderr: '', exitCode: 0 });
      await expect(tmux.waitSubmitAck(PANE, baseline, 'codex', { timeoutMs: 200, intervalMs: 50 }))
        .rejects.toThrow(/runtime ack timeout/);
    });

    it('codex: spinner high on viewport is stale; the fresh Working footer under the cleared composer acks', async () => {
      const baseline = buildBaseline('→ baxian git:(main)\nidle prompt text\n', 0);
      const lines = ['· Thinking… (2s)', ...blank(12), '› ', '• Working (2s • esc to interrupt)'].join('\n') + '\n';
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
        stdout: composeSnapStdout(submitted ? '✻ Working… (3s · esc to interrupt)\n' : 'idle composer\n', 0),
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
        stdout: composeSnapStdout(submitted ? '✻ Working… (3s · esc to interrupt)\n' : longComposer, 0),
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
        stdout: composeSnapStdout(submitted ? '✻ Working… (3s · esc to interrupt)\n' : 'idle composer\n\n', 0),
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
        stdout: composeSnapStdout(submitted ? '› \n• Working (2s • esc to interrupt)\n' : held, 0),
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
        stdout: composeSnapStdout(submitted ? '› \n• Working (2s • esc to interrupt)\n' : held, 0),
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
        stdout: composeSnapStdout('Pick one\nEnter to confirm · Esc to cancel\n', 0),
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

  describe('capturePaneById codex sparkle blanking', () => {
    it('blanks single-dot braille only inside the composer band; transcript braille above it is real content', async () => {
      primeExec(okBody(
        'Braille progress: ⠁\n'
        + '\n'
        + ' ⠂  ⠄\n'
        + '› draft⠈\n'
        + '  ⠐ line two⠠\n'
        + '⡀    ⢀\n'
        + '  gpt-6-astra xhigh · ~/repo\n',
      ));
      await expect(tmux.capturePaneById(PANE, { ansi: false, scrollback: 0, runtime: 'codex' })).resolves.toBe(
        'Braille progress: ⠁\n'
        + '\n'
        + '     \n'
        + '› draft \n'
        + '    line two \n'
        + '      \n'
        + '  gpt-6-astra xhigh · ~/repo\n',
      );
    });

    it('absorbs remote image attachment rows ([Image #N]) and the blanks above them into the band', async () => {
      primeExec(okBody(
        'Braille progress: ⠁\n'
        + '\n'
        + ' ⠂   \n'
        + '[Image #1] ⠄  ⠈\n'
        + '⠐  \n'
        + '› draft⡀\n'
        + '  ⢀\n'
        + '  gpt-6-astra xhigh · ~/repo\n',
      ));
      await expect(tmux.capturePaneById(PANE, { ansi: false, scrollback: 0, runtime: 'codex' })).resolves.toBe(
        'Braille progress: ⠁\n'
        + '\n'
        + '     \n'
        + '[Image #1]     \n'
        + '   \n'
        + '› draft \n'
        + '   \n'
        + '  gpt-6-astra xhigh · ~/repo\n',
      );
    });

    it('tolerates a sparkle inside an [Image #N] label ([Image⠐#2]) while locating the band', async () => {
      primeExec(okBody(
        'Braille progress: ⠁\n'
        + ' ⠂\n'
        + '[Image #1]  ⠄\n'
        + '[Image⠐#2]\n'
        + '⠈\n'
        + '› draft⠠\n'
        + '  gpt-6-astra xhigh · ~/repo\n',
      ));
      await expect(tmux.capturePaneById(PANE, { ansi: false, scrollback: 0, runtime: 'codex' })).resolves.toBe(
        'Braille progress: ⠁\n'
        + '  \n'
        + '[Image #1]   \n'
        + '[Image #2]\n'
        + ' \n'
        + '› draft \n'
        + '  gpt-6-astra xhigh · ~/repo\n',
      );
    });

    it('keeps output after a history › untouched when the composer is off screen (a response marker follows the prompt)', async () => {
      primeExec(okBody(
        '› run the command\n'
        + '• Working (4s • esc to interrupt)\n'
        + '  └ Braille progress: ⠁\n',
      ));
      await expect(tmux.capturePaneById(PANE, { ansi: false, scrollback: 0, runtime: 'codex' })).resolves.toBe(
        '› run the command\n'
        + '• Working (4s • esc to interrupt)\n'
        + '  └ Braille progress: ⠁\n',
      );
    });

    it('anchors on the Ultra » composer and leaves the history › output above it untouched', async () => {
      primeExec(okBody(
        '› run the command\n'
        + '• Ran echo ⠁\n'
        + '\n'
        + '⠂  ⠄\n'
        + '» draft⠈\n'
        + '  ⠐\n'
        + '  gpt-6-astra ultra · ~/repo\n',
      ));
      await expect(tmux.capturePaneById(PANE, { ansi: false, scrollback: 0, runtime: 'codex' })).resolves.toBe(
        '› run the command\n'
        + '• Ran echo ⠁\n'
        + '\n'
        + '    \n'
        + '» draft \n'
        + '   \n'
        + '  gpt-6-astra ultra · ~/repo\n',
      );
    });

    it.each([
      ['column-0 composer', '› Please review⠁\n  • include tests⠂\n  ✓ done⠄\n⠈\n  gpt-6-astra xhigh · ~/repo\n',
        '› Please review \n  • include tests \n  ✓ done \n \n  gpt-6-astra xhigh · ~/repo\n'],
      ['indented composer', 'prior output\n  › Please review⠁\n    • include tests⠂\n  ⠄\n',
        'prior output\n  › Please review \n    • include tests \n   \n'],
    ])('%s: draft continuation lines starting with •/✓ are composer content, not history replies', async (_label, screen, expected) => {
      primeExec(okBody(screen));
      await expect(tmux.capturePaneById(PANE, { ansi: false, scrollback: 0, runtime: 'codex' })).resolves.toBe(expected);
    });

    it('leaves the body untouched when no composer is on screen', async () => {
      primeExec(okBody('Braille progress: ⠁\n⠂ ⠄\n'));
      await expect(tmux.capturePaneById(PANE, { ansi: false, scrollback: 0, runtime: 'codex' })).resolves.toBe(
        'Braille progress: ⠁\n⠂ ⠄\n',
      );
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

    it('codex: treats sparkle-only repaints (single-dot braille) as settled and blanks them in the snapshot', async () => {
      primeSnapshot('› draft⠁\n ⠂  ⠄ \n', 0);
      primeSnapshot('› draft \n⠈    ⡀\n', 0);
      const snap = await tmux.captureSettledSnapshot(PANE, { timeoutMs: 2000, intervalMs: 10, runtime: 'codex' });
      expect(snap).toBe(buildSnapshot('› draft\n\n', 0));
      expect(runner.exec.mock.calls.length).toBe(2);
    });

    it('codex: settles when only the rightmost sparkle column differs (capture-pane trims trailing blanks per line)', async () => {
      primeSnapshot('› draft⠁\n  ⠂\n', 0);
      primeSnapshot('› draft\n⠈      ⡀\n', 0);
      const snap = await tmux.captureSettledSnapshot(PANE, { timeoutMs: 2000, intervalMs: 10, runtime: 'codex' });
      expect(snap).toBe(buildSnapshot('› draft\n\n', 0));
      expect(runner.exec.mock.calls.length).toBe(2);
    });

    it('codex: settles an indented bare composer whose sparkles move below it', async () => {
      primeSnapshot('  › \n ⠁ \n', 0);
      primeSnapshot('  › \n  ⠂\n', 0);
      const snap = await tmux.captureSettledSnapshot(PANE, { timeoutMs: 2000, intervalMs: 10, runtime: 'codex' });
      expect(snap).toBe(buildSnapshot('  ›\n\n', 0));
      expect(runner.exec.mock.calls.length).toBe(2);
    });

    it('codex: settles when sparkles move right of and above an [Image #1] attachment row', async () => {
      primeSnapshot('⠁\n[Image #1] ⠂\n\n› draft\n', 0);
      primeSnapshot('  ⠄\n[Image #1]    ⠈\n⠐\n› draft\n', 0);
      const snap = await tmux.captureSettledSnapshot(PANE, { timeoutMs: 2000, intervalMs: 10, runtime: 'codex' });
      expect(snap).toBe(buildSnapshot('\n[Image #1]\n\n› draft\n', 0));
      expect(runner.exec.mock.calls.length).toBe(2);
    });

    it('codex: settles when a sparkle lands inside the [Image #2] label between two frames', async () => {
      primeSnapshot('[Image #1]\n[Image #2]  ⠁\n› x\n', 0);
      primeSnapshot('[Image #1] ⠂\n[Image⠐#2]\n› x\n', 0);
      const snap = await tmux.captureSettledSnapshot(PANE, { timeoutMs: 2000, intervalMs: 10, runtime: 'codex' });
      expect(snap).toBe(buildSnapshot('[Image #1]\n[Image #2]\n› x\n', 0));
      expect(runner.exec.mock.calls.length).toBe(2);
    });

    it('codex: settles a multi-line draft whose second line starts with • while sparkles move', async () => {
      primeSnapshot('› Please review⠁\n  • include tests\n ⠂\n', 0);
      primeSnapshot('› Please review\n  • include tests ⠄\n⠈\n', 0);
      const snap = await tmux.captureSettledSnapshot(PANE, { timeoutMs: 2000, intervalMs: 10, runtime: 'codex' });
      expect(snap).toBe(buildSnapshot('› Please review\n  • include tests\n\n', 0));
      expect(runner.exec.mock.calls.length).toBe(2);
    });

    it('non-codex: single-dot braille stays in the snapshot untouched', async () => {
      primeSnapshot('⠁ Thinking...\n', 0);
      primeSnapshot('⠁ Thinking...\n', 0);
      const snap = await tmux.captureSettledSnapshot(PANE, { timeoutMs: 2000, intervalMs: 10, runtime: 'qodercli' });
      expect(snap).toBe(buildSnapshot('⠁ Thinking...\n', 0));
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
    const sentKeys = (): string[] =>
      runner.exec.mock.calls.map(c => String(c[0])).filter(c => c.includes('send-keys'));
    const CC_TRUST_BODY = ' Accessing workspace:\n\n /Users/example/.baxian/agents/example-dev/repo\n\n'
      + ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this\n'
      + ' folder first.\n\n Claude Code\'ll be able to read, edit, and execute files here.\n\n Security guide\n\n';
    const CC_TRUST_NO_PRESELECTED = `${CC_TRUST_BODY} ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`;
    const CC_TRUST_YES_HIGHLIGHTED = `${CC_TRUST_BODY}   No, exit\n ❯ Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`;

    it('legacy claude dialog preselecting Yes: sends Enter directly', async () => {
      primeExec(okBody('Quick safety check\n❯ 1. Yes, I trust this folder\n'), '');
      const answered = await tmux.handleTrustDialog(PANE, 'claude-code', { timeoutMs: 1000, intervalMs: 50 });
      expect(answered).toBe(true);
      expect(sentKeys()).toHaveLength(1);
      expect(sentKeys()[0]).toContain("'Enter'");
    });

    it('claude dialog preselecting "No, exit": moves the cursor Down onto Yes before Enter', async () => {
      primeExec(okBody(CC_TRUST_NO_PRESELECTED), '', okBody(CC_TRUST_YES_HIGHLIGHTED), '');
      const answered = await tmux.handleTrustDialog(PANE, 'claude-code', { timeoutMs: 1000, intervalMs: 50 });
      expect(answered).toBe(true);
      expect(sentKeys()).toHaveLength(2);
      expect(sentKeys()[0]).toContain("'Down'");
      expect(sentKeys()[1]).toContain("'Enter'");
    });

    it('claude dialog with Yes already highlighted (current wording): sends Enter directly', async () => {
      primeExec(okBody(CC_TRUST_YES_HIGHLIGHTED), '');
      const answered = await tmux.handleTrustDialog(PANE, 'claude-code', { timeoutMs: 1000, intervalMs: 50 });
      expect(answered).toBe(true);
      expect(sentKeys()).toHaveLength(1);
      expect(sentKeys()[0]).toContain("'Enter'");
    });

    it('sends Down once then keeps polling until a slow redraw lands the cursor on Yes', async () => {
      let captures = 0;
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('send-keys')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('capture-pane')) {
          captures += 1;
          // 1st = top-of-loop detect (No); 2nd = right after Down, redraw not yet done (No); 3rd = Yes
          return { stdout: `BX_PANE_OK\n${captures >= 3 ? CC_TRUST_YES_HIGHLIGHTED : CC_TRUST_NO_PRESELECTED}`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const answered = await tmux.handleTrustDialog(PANE, 'claude-code', { timeoutMs: 2000, intervalMs: 50 });
      expect(answered).toBe(true);
      const downs = sentKeys().filter(k => k.includes("'Down'"));
      expect(downs).toHaveLength(1);
      expect(sentKeys().at(-1)).toContain("'Enter'");
    });

    it('never presses Enter and gives up for a human when the cursor never leaves "No, exit"', async () => {
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('send-keys')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('capture-pane')) return { stdout: `BX_PANE_OK\n${CC_TRUST_NO_PRESELECTED}`, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const answered = await tmux.handleTrustDialog(PANE, 'claude-code', { timeoutMs: 400, intervalMs: 50 });
      expect(answered).toBe(false);
      expect(sentKeys().filter(k => k.includes("'Down'"))).toHaveLength(1);
      expect(sentKeys().some(k => k.includes("'Enter'"))).toBe(false);
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
      [
        'codex: accepts the idle composer while Astra sparkles (single-dot braille) play over the composer band',
        'node\n',
        '─ Worked for 6m 54s ─────────────────────────────\n' +
          '⠁   ⠈         ⠄                 ⠁ ⢀                ⠐      ⠂\n' +
          '› Ask Codex to do anything⡀                          ⠁⠐  ⠈\n' +
          '       ⢀⠐                 ⠄         ⠠        ⢀ ⢀    ⠠     ⡀\n' +
          '  gpt-6-astra xhigh · ~/.baxian/agents/qa/repo · Retry\n',
        'codex' as const,
      ],
      [
        'codex: accepts the sparkled idle composer on the -e capture path (escapes around glyphs and before ›)',
        'node\n',
        '─ Worked for 3m 03s ─────────────────────────────\n' +
          '\x1b[38;2;200;200;255m⠁\x1b[39m   \x1b[38;2;90;90;140m⠈\x1b[39m\n' +
          '\x1b[1m›\x1b[0m Ask Codex to do anything\x1b[38;2;1;2;3m⡀\x1b[0m\n' +
          '  \x1b[38;2;7;7;7m⠂\x1b[39m\n' +
          '  gpt-6-astra xhigh · ~/.baxian/agents/qa/repo\n',
        'codex' as const,
      ],
      [
        'codex: accepts an INDENTED bare › with sparkles below it (band anchor tolerates leading blanks)',
        'node\n',
        'prior output\n  › \n  ⠁  \n',
        'codex' as const,
      ],
      [
        'codex: accepts an indented › wrapped in escapes and blanks with sparkles around it',
        'node\n',
        'prior output\n\x1b[2m  \x1b[0m›\x1b[0m \n \x1b[38;2;1;2;3m⠂\x1b[39m \n',
        'codex' as const,
      ],
      [
        'codex: accepts the idle composer when a sparkle replaces the space after ›',
        'node\n',
        '─ Worked for 2m 10s ─────────────────────────────\n\n' +
          '›⠁Ask Codex to do anything\n' +
          '  ⠂      ⠄\n' +
          '  gpt-6-astra xhigh · ~/.baxian/agents/qa/repo\n',
        'codex' as const,
      ],
    ])('%s', async (_label, procTitle, anchor, runtimeKind) => {
      primeExec(okHeader(procTitle.trim()), okBody(anchor));
      await expect(
        tmux.waitReplReady(PANE, runtimeKind, { timeoutMs: 1000, intervalMs: 30 }),
      ).resolves.toBeUndefined();
    });

    it.each(['⠁', '⠂', '⠄', '⠈', '⠐', '⠠', '⡀', '⢀'])(
      'qodercli: a %s spinner frame at line start stays working evidence (sparkle blanking is codex-only)',
      async (frame) => {
        runner.exec.mockImplementation(async (cmd: string) => {
          if (cmd.includes('pane_current_command')) {
            return { stdout: okHeader('qodercli'), stderr: '', exitCode: 0 };
          }
          return {
            stdout: okBody(`${frame} Thinking...\nType your message or @path/to/file\n`),
            stderr: '',
            exitCode: 0,
          };
        });
        await expect(
          tmux.waitReplReady(PANE, 'qodercli', { timeoutMs: 120, intervalMs: 30 }),
        ).rejects.toThrow(/repl not ready/);
      },
    );

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

    it('codex: accepts the idle pinned composer when tmux keeps styled blanks as whitespace rows', async () => {
      primeExec(
        okHeader('node'),
        okBody(
          '─ Worked for 9m 16s ───────\n \n \n'
          + '› Ask Codex to do anything\n \n'
          + '  gpt-5.6-sol xhigh · ~/.baxian/agents/qa/repo\n',
        ),
      );
      await expect(
        tmux.waitReplReady(PANE, 'codex', { timeoutMs: 200, intervalMs: 30 }),
      ).resolves.toBeUndefined();
    });

    it('keeps polling when only the proc title matches (anchor still missing)', async () => {
      primeExec(okHeader('node'), okBody('still booting\n'), okHeader('node'), okBody('permissions: YOLO mode\n'));
      await expect(tmux.waitReplReady(PANE, 'codex', { timeoutMs: 2000, intervalMs: 30 })).resolves.toBeUndefined();
      expect(runner.exec.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    function mockPane(procAtRead: (read: number) => string, screen: string): { procReads: () => number } {
      let procReads = 0;
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('pane_current_command')) {
          return { stdout: okHeader(procAtRead(++procReads)), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) return { stdout: okBody(screen), stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      return { procReads: () => procReads };
    }

    it('failFastOnShell:true waits through a shell that has not started the runtime yet, then succeeds', async () => {
      // slow shell preexec/env hooks: the foreground is the shell before the runtime binary execs
      const pane = mockPane(read => read <= 2 ? 'zsh' : 'claude', '⏵⏵ bypass permissions on (shift+tab to cycle)\n');
      await expect(
        tmux.waitReplReady(PANE, 'claude-code', {
          timeoutMs: 5000, intervalMs: 10, failFastOnShell: true,
        }),
      ).resolves.toBeUndefined();
      expect(pane.procReads()).toBeGreaterThanOrEqual(3);
    });

    it('failFastOnShell:true aborts once a previously-observed runtime falls back to the shell', async () => {
      mockPane(read => read >= 2 ? 'zsh' : 'claude', 'booting…\n');
      const err = await tmux.waitReplReady(PANE, 'claude-code', {
        timeoutMs: 5000, intervalMs: 10, failFastOnShell: true,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(true);
      expect((err as Error).message).toMatch(/failFastOnShell/);
    });

    it('failFastOnShell:true re-checks the foreground at the deadline so a last-moment exit to shell is marked shellForeground', async () => {
      // REPL still alive during the loop, then exits to the shell right before the deadline re-check
      mockPane(read => read >= 2 ? 'zsh' : 'claude', 'booting…\n Enter to confirm · Esc to cancel\n');
      const err = await tmux.waitReplReady(PANE, 'claude-code', {
        timeoutMs: 40, intervalMs: 50, failFastOnShell: true,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(true);
    });

    it('failFastOnShell:true reports shellForeground at the deadline for a plain shell that never started the runtime', async () => {
      // plain shell prompt: no startup dialog text, and the runtime was never observed
      mockPane(() => 'zsh', '➜  repo git:(main)\n');
      const err = await tmux.waitReplReady(PANE, 'claude-code', {
        timeoutMs: 40, intervalMs: 50, failFastOnShell: true,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReplNotReadyError);
      expect((err as ReplNotReadyError).shellForeground).toBe(true);
    });

    it('completes the readiness check for a probe that started before the deadline but returned after it', async () => {
      let procReads = 0;
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('pane_current_command')) {
          procReads += 1;
          // the 2nd foreground probe starts in-window but its reply crosses the deadline; the runtime is ready by then
          if (procReads >= 2) await new Promise((r) => setTimeout(r, 40));
          return { stdout: okHeader('claude'), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          const screen = procReads >= 2 ? '⏵⏵ bypass permissions on (shift+tab to cycle)\n' : 'booting…\n';
          return { stdout: okBody(screen), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      await expect(
        tmux.waitReplReady(PANE, 'claude-code', {
          timeoutMs: 30, intervalMs: 5, failFastOnShell: true,
        }),
      ).resolves.toBeUndefined();
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

      it('claude-code: "✳ " title does not shortcut an actively busy screen (live spinner in tail)', async () => {
        mockPaneState('2.1.199', `${NARROW_IDLE_SCREEN}\n✻ 部署中… (3s · esc to interrupt)\n`, '✳ 部署服务');
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

      it('herdr boundary: a narrow-wrapped select-option form is undetectable (contains 不跨行), the ✳ title fast path proceeds', async () => {
        mockPaneState(
          '2.1.199',
          '选择合并策略：\n❯ 1. squash\n  2. rebase\n\nEnter to select ·\nEsc to cancel · Tab/arrow\nkeys to navigate\n',
          '✳ 等待合并策略选择',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('claude-code: a pending-prompt phrase far above the tail does not veto an idle bottom screen', async () => {
        const history = '…上文引用：do you want to proceed? 的行为分析\n' + '正文\n'.repeat(16);
        mockPaneState('2.1.199', history + NARROW_IDLE_SCREEN, '✳ 分析报告');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('does not read the pane title while the screen is visibly busy (sync short-circuit first)', async () => {
        mockPaneState('2.1.199', `${NARROW_IDLE_SCREEN}\n✻ 部署中… (3s · esc to interrupt)\n`, '✳ 部署服务');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
        const titleReads = runner.exec.mock.calls.filter(c => String(c[0]).includes('pane_title'));
        expect(titleReads.length).toBe(1);
      });

      it('claude-code: a screen-only ready view never shortcuts a working OSC title', async () => {
        mockPaneState('2.1.199', `${NARROW_IDLE_SCREEN}\n⏵⏵ bypass permissions on (shift+tab to cycle)\n`, '⠹ 部署服务');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: the working-title veto applies even without titleIdleFastPath', async () => {
        mockPaneState('2.1.199', `${NARROW_IDLE_SCREEN}\n⏵⏵ bypass permissions on (shift+tab to cycle)\n`, '⠹ 部署服务');
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30 }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('timeout on a busy screen still reports the pane title via the failure-path fallback read', async () => {
        mockPaneState('2.1.199', `${NARROW_IDLE_SCREEN}\n✻ 部署中… (3s · esc to interrupt)\n`, '⠹ 部署服务');
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
          'transcript content line\nShowing detailed transcript\nctrl+o to toggle · esc to close\n',
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

      it('herdr flip: a quoted offer phrase plus a ❯ draft token satisfies the legacy blocker and vetoes the fast path', async () => {
        mockPaneState(
          '2.1.199',
          `表单文案 "would you like to" 已覆盖。\n${NARROW_IDLE_SCREEN}\n❯ run tests\n`,
          '✳ 跑测试收尾',
        );
        await expect(
          tmux.waitReplReady(PANE, 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
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

    it.each([
      ['the read fails', { stdout: '', stderr: 'pane not found', exitCode: 1 }],
      ['the pane identity is gone', { stdout: 'BX_TARGET_GONE\n', stderr: '', exitCode: 0 }],
    ])('returns empty string when %s (advisory signal, never authority)', async (_label, result) => {
      runner.exec.mockResolvedValueOnce(result);
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

  it.each([
    ['tmux >= 3.6 no-target expansion (exit 0, empty session_id)', '  on latest |2491|1784128830|||3.6a|1|\n'],
    ['a no-target expansion polluted by a global @-option smuggling pipes', '  on latest ||||84630|1785741685|||3.6a|1|\n'],
  ])('getWindowGeometry: %s is typed absent, not unparseable', async (_label, stdout) => {
    const runner = mockRunner();
    runner.exec.mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
    const tmux = new TmuxManager(runner);
    await expect(tmux.getWindowGeometry('dev-1')).rejects.toBeInstanceOf(SessionAbsentError);
  });

  it.each([
    ['an empty-tailed line without the format separators', 'x|\n'],
    ['a live session whose owner-gen option smuggles pipes (stays fail-closed)', '80 24 on latest ||||55388|1785690647|$0||3.6a|1|$0\n'],
    ['exit 0 with empty stdout', ''],
  ])('getWindowGeometry: %s is unparseable, NOT absent', async (_label, stdout) => {
    const runner = mockRunner();
    runner.exec.mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
    const tmux = new TmuxManager(runner);
    const err = await tmux.getWindowGeometry('dev-1').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SessionAbsentError);
    expect(err).toBeInstanceOf(Error);
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

// 真实 tmux 的 send-keys 用 getopt 解析,正文是第一个位置参数:'-l' 会被当成又一个选项吞掉(退出 0、什么也不送),
// 其它 - 开头的正文直接 unknown flag 退出 1。选项终止符 -- 之后的参数才一定按正文/键名处理
const FAKE_PANE: PaneRef = {
  session: { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' },
  paneId: '%0',
  claim: 'dev-1',
};

// 真实 tmux 的 display-message 会先把整串交给 strftime,%N 形态的 pane id 字面量活不到比较那一步:
// 拒绝回执里的身份位因此恒为 0,每一次前台不匹配都被误报成 PaneGoneError
describe('a refusal on a live pane is classified by its foreground, not reported as a gone pane', () => {
  it('a shell foreground withholds the line as ReplNotReadyError and types nothing', async () => {
    const runner = fakeRunner({ agents: { 'dev-1': { process: 'zsh' } } });
    const tmux = new TmuxManager(runner);

    const err = await tmux.submitToRuntime(FAKE_PANE, 'claude-code', 'hello').catch(e => e);

    expect(err).toBeInstanceOf(ReplNotReadyError);
    expect((err as ReplNotReadyError).shellForeground).toBe(true);
    expect(runner.sessions.pane('dev-1')!.composer).toBe('');
  });

  it('a pane whose identity really changed is still PaneGoneError', async () => {
    const runner = fakeRunner();
    const tmux = new TmuxManager(runner);
    runner.sessions.bumpGeneration('dev-1');

    await expect(tmux.submitToRuntime(FAKE_PANE, 'claude-code', 'hello')).rejects.toThrow(PaneGoneError);
    expect(runner.sessions.pane('dev-1')!.composer).toBe('');
  });
});

describe('option-shaped payloads reach the pane instead of being parsed as flags', () => {
  it.each(['-l', '-x', '--force', '--'])('sendKeysLiteral types %j into the composer', async (text) => {
    const runner = fakeRunner();
    const tmux = new TmuxManager(runner);
    await tmux.sendKeysLiteral(FAKE_PANE, text, 'claude-code');
    expect(runner.sessions.pane('dev-1')!.composer).toBe(text);
  });

  it.each(['-l', '-x'])('submitToRuntime delivers the line %j and its Enter', async (text) => {
    const runner = fakeRunner();
    const tmux = new TmuxManager(runner);
    await tmux.submitToRuntime(FAKE_PANE, 'claude-code', text);
    const pane = runner.sessions.pane('dev-1')!;
    expect(pane.phase).toBe('working');
    expect(pane.composer).toBe('');
  });

  it('C-c after the option terminator still clears the composer instead of being typed', async () => {
    const runner = fakeRunner();
    const tmux = new TmuxManager(runner);
    await tmux.sendKeysLiteral(FAKE_PANE, 'draft', 'claude-code');
    expect(runner.sessions.pane('dev-1')!.composer).toBe('draft');
    await tmux.sendKeysToPane(FAKE_PANE, 'C-c');
    expect(runner.sessions.pane('dev-1')!.composer).toBe('');
  });

  it('Enter after the option terminator still submits the composer instead of being typed', async () => {
    const runner = fakeRunner();
    const tmux = new TmuxManager(runner);
    await tmux.sendKeysLiteral(FAKE_PANE, 'hello', 'claude-code');
    await tmux.sendKeysToPane(FAKE_PANE, 'Enter');
    const pane = runner.sessions.pane('dev-1')!;
    expect(pane.phase).toBe('working');
    expect(pane.composer).toBe('');
  });
});
