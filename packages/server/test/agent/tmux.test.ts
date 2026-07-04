import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TmuxManager, detectStartupDialog, detectRuntimeMenu, detectReplActiveBusy, detectRuntimePendingPrompt, detectRuntimeOverlay, hasActiveSpinner, hasActiveSpinnerInTail, hasRuntimeReadyView, hasRuntimeIdleComposerPrompt, hasOscTitleWorking, hasOscTitleIdle, runtimeBusyCheck } from '../../src/agent/tmux.js';
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

const SNAP_SEP = '___bx-snap-sep___';
const composeSnapStdout = (visible: string, history: string | number): string =>
  `${visible}${SNAP_SEP}\n${history}\n`;
const buildSnapshot = (visible: string, history: number): string =>
  `${visible}\n---history_size:${history}---`;

describe('TmuxManager', () => {
  let runner: ReturnType<typeof mockRunner>;
  let tmux: TmuxManager;

  beforeEach(() => {
    runner = mockRunner();
    tmux = new TmuxManager(runner);
  });

  describe('createSession', () => {
    it('runs tmux new-session with raw session name (no exact-match prefix needed for new sessions)', async () => {
      await tmux.createSession('kk-dev-1', '/home/user/code');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('tmux new-session -d');
      expect(cmd).toContain("-s 'kk-dev-1'");
      expect(cmd).toContain("-c '/home/user/code'");
    });

    it('sets default pane size 200x50 via -x/-y', async () => {
      await tmux.createSession('kk-dev-1', '/home/user/code');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('-x 200');
      expect(cmd).toContain('-y 50');
    });

    it('injects literal PATH via tmux -e (no shell-side $PATH expansion → fish-safe)', async () => {
      await tmux.createSession('kk-dev-1', '/home/user/code');
      const cmd = lastCmd(runner);
      expect(cmd).toContain(
        "-e 'PATH=/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'",
      );
      expect(cmd).not.toContain('$PATH');
    });

    it('does NOT chain post-create options (those live in buildFreshSession for rollback safety)', async () => {
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

  describe('resizeWindow', () => {
    it('uses `=name` exact target so prefix collisions cannot resize the wrong session', async () => {
      await tmux.resizeWindow('dev', 100, 30);
      const cmd = lastCmd(runner);
      expect(cmd).toContain('tmux resize-window');
      expect(cmd).toContain("-t '=dev'");
      expect(cmd).toContain('-x 100');
      expect(cmd).toContain('-y 30');
    });

    it('throws on non-zero exit', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'window not found', exitCode: 1 });
      await expect(tmux.resizeWindow('dev', 80, 24)).rejects.toThrow(/window not found/);
    });
  });

  describe('sendInput (load-buffer + paste-buffer + cleanup)', () => {
    it('runs load-buffer (stdin) → paste-buffer → delete-buffer in order', async () => {
      runner.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      await tmux.sendInput('dev-1', 'hello world');
      const execWithStdinMock = (runner as unknown as { execWithStdin: ExecMock }).execWithStdin;
      expect(execWithStdinMock).toHaveBeenCalledTimes(1);
      const loadCmd = execWithStdinMock.mock.calls[0][0] as string;
      expect(loadCmd).toContain('tmux load-buffer -b');
      expect(loadCmd).toContain("'bx-input-");
      expect(runner.exec).toHaveBeenCalledTimes(2);
      const pasteCmd = runner.exec.mock.calls[0][0] as string;
      const deleteCmd = runner.exec.mock.calls[1][0] as string;
      expect(pasteCmd).toContain('tmux paste-buffer');
      expect(pasteCmd).toContain("-d -b 'bx-input-");
      expect(pasteCmd).toContain("-t '=dev-1:'");
      expect(deleteCmd).toContain('tmux delete-buffer -b');
    });

    it('uses `=<name>:` target — `=` for exact-match, trailing `:` so paste-buffer can derive the active pane', async () => {
      await tmux.sendInput('dev', 'x');
      const pasteCmd = runner.exec.mock.calls[0][0] as string;
      expect(pasteCmd).toContain("-t '=dev:'");
      expect(pasteCmd).not.toMatch(/-t '=dev'(?!:)/);
      expect(pasteCmd).not.toMatch(/-t 'dev'(?!-)/);
    });

    it('passes raw bytes (incl. utf8 multibyte + control chars) via stdin Buffer', async () => {
      const data = '中文 🚀 \x03\x1b[A\r\n';
      await tmux.sendInput('dev', data);
      const execWithStdinMock = (runner as unknown as { execWithStdin: ExecMock }).execWithStdin;
      const stdinBuf = execWithStdinMock.mock.calls[0][1] as Buffer;
      expect(stdinBuf).toBeInstanceOf(Buffer);
      expect(stdinBuf.toString('utf8')).toBe(data);
    });

    it('still calls delete-buffer even when paste-buffer fails (leak prevention)', async () => {
      const execWithStdinMock = (runner as unknown as { execWithStdin: ExecMock }).execWithStdin;
      execWithStdinMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: "can't find pane", exitCode: 1 });
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      await expect(tmux.sendInput('dev', 'data')).rejects.toThrow(/paste-buffer failed/);
      expect(runner.exec).toHaveBeenCalledTimes(2);
      const deleteCmd = runner.exec.mock.calls[1][0] as string;
      expect(deleteCmd).toContain('tmux delete-buffer -b');
    });

    it('throws when load-buffer (stdin path) fails — does not call paste', async () => {
      const execWithStdinMock = (runner as unknown as { execWithStdin: ExecMock }).execWithStdin;
      execWithStdinMock.mockResolvedValueOnce({ stdout: '', stderr: 'no server', exitCode: 1 });
      await expect(tmux.sendInput('dev', 'x')).rejects.toThrow(/load-buffer failed/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
      const cmd = runner.exec.mock.calls[0][0] as string;
      expect(cmd).toContain('tmux delete-buffer');
    });

    it('is a no-op when data is empty', async () => {
      await tmux.sendInput('dev', '');
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('uses unique buffer names per call (random uuid prefix)', async () => {
      await tmux.sendInput('dev', 'a');
      await tmux.sendInput('dev', 'b');
      const execWithStdinMock = (runner as unknown as { execWithStdin: ExecMock }).execWithStdin;
      const cmd1 = execWithStdinMock.mock.calls[0][0] as string;
      const cmd2 = execWithStdinMock.mock.calls[1][0] as string;
      const bufFromCmd = (s: string): string => {
        const m = /'(bx-input-[0-9a-f-]+)'/.exec(s);
        if (!m) throw new Error(`no buffer name in: ${s}`);
        return m[1];
      };
      expect(bufFromCmd(cmd1)).not.toBe(bufFromCmd(cmd2));
    });
  });

  describe('probeTmuxVersion', () => {
    it.each([
      ['tmux 3.6a\n', { major: 3, minor: 6 }, '"tmux 3.6a"'],
      ['tmux 3.4\n', { major: 3, minor: 4 }, '"tmux 3.4" (no suffix)'],
      ['tmux next-3.5\n', { major: 3, minor: 5 }, '"tmux next-3.5" (development build)'],
    ])('parses %j → %j', async (stdout, expected) => {
      runner.exec.mockResolvedValueOnce({ stdout, stderr: '', exitCode: 0 });
      expect(await TmuxManager.probeTmuxVersion(runner)).toEqual(expected);
    });

    it('throws on non-zero exit', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'tmux: command not found', exitCode: 127 });
      await expect(TmuxManager.probeTmuxVersion(runner)).rejects.toThrow(/tmux -V failed/);
    });

    it('throws on unparseable output (no version pattern)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'something unexpected\n', stderr: '', exitCode: 0 });
      await expect(TmuxManager.probeTmuxVersion(runner)).rejects.toThrow(/unparseable/);
    });
  });

  describe('killSession', () => {
    it('uses exact-match `=name` target so prefix collisions are not killed', async () => {
      await tmux.killSession('dev');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('tmux kill-session');
      expect(cmd).toContain("-t '=dev'");
    });

    it.each([
      ['"session not found"', "can't find session: dev"],
      ['"no server running"', 'no server running on /tmp/tmux-501/default'],
    ])('treats %s as success (idempotent)', async (_label, stderr) => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr, exitCode: 1 });
      await expect(tmux.killSession('dev')).resolves.toBeUndefined();
    });

    it.each([
      ['ssh-layer error (exit 255)', 'ssh: connect: connection refused', 255, /runner error/],
      ['unexpected exit code', 'wat', 42, /unexpected exit 42/],
    ])('throws on %s', async (_label, stderr, exitCode, pattern) => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr, exitCode });
      await expect(tmux.killSession('dev')).rejects.toThrow(pattern);
    });
  });

  describe('hasSession', () => {
    it('returns true on exit 0 with exact target', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
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
      ['exit 255 (ssh layer) — does not silently report absence', 'ssh: timeout', 255, /runner error/],
      ['unexpected exit (not absence-classified)', 'permission denied', 7, /unexpected exit 7/],
      ['exit=1 with empty stderr (do NOT silently treat as absent)', '', 1, /unexpected exit 1/],
    ])('throws on %s', async (_label, stderr, exitCode, pattern) => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr, exitCode });
      await expect(tmux.hasSession('dev')).rejects.toThrow(pattern);
    });
  });

  describe('listPanes', () => {
    it('parses `paneId pane_current_command` lines', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: '%0 zsh\n%1 claude\n',
        stderr: '', exitCode: 0,
      });
      const panes = await tmux.listPanes('dev');
      expect(panes).toEqual([
        { paneId: '%0', current: 'zsh' },
        { paneId: '%1', current: 'claude' },
      ]);
      expect(lastCmd(runner)).toContain("-t '=dev'");
      expect(lastCmd(runner)).toContain("-F '#{pane_id} #{pane_current_command}'");
    });

    it.each([
      ['single-pane session', '%0 node\n', [{ paneId: '%0', current: 'node' }]],
      ['paneId without command', '%0\n', [{ paneId: '%0', current: '' }]],
    ])('handles %s', async (_label, stdout, expected) => {
      runner.exec.mockResolvedValueOnce({ stdout, stderr: '', exitCode: 0 });
      expect(await tmux.listPanes('dev')).toEqual(expected);
    });
  });

  describe('getSinglePaneId', () => {
    it('returns the only pane id when there is exactly one', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '%0 claude\n', stderr: '', exitCode: 0 });
      expect(await tmux.getSinglePaneId('dev')).toBe('%0');
    });

    it.each([
      ['zero panes (session damaged)', '', /no panes/],
      ['multiple panes (does not silently pick the first one)', '%0 zsh\n%1 vim\n', /expects exactly one/],
    ])('throws when %s', async (_label, stdout, pattern) => {
      runner.exec.mockResolvedValueOnce({ stdout, stderr: '', exitCode: 0 });
      await expect(tmux.getSinglePaneId('dev')).rejects.toThrow(pattern);
    });
  });

  describe('displayMessage', () => {
    it('queries pane_current_command via display-message -p', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'claude\n', stderr: '', exitCode: 0 });
      const out = await tmux.displayMessage('%0', '#{pane_current_command}');
      expect(out).toBe('claude');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('display-message -p');
      expect(cmd).toContain("-t '%0'");
      expect(cmd).toContain('#{pane_current_command}');
    });
  });

  describe('setOption / getOption (session-scoped target needs trailing colon)', () => {
    it('setOption uses `=name:` exact target', async () => {
      await tmux.setOption('dev', '@baxian-agent-id', 'dev');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('tmux set-option');
      expect(cmd).toContain("-t '=dev:'");
      expect(cmd).toContain("'@baxian-agent-id'");
    });

    it('getOption returns the value when present', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'dev\n', stderr: '', exitCode: 0 });
      expect(await tmux.getOption('dev', '@baxian-agent-id')).toBe('dev');
      expect(lastCmd(runner)).toContain("-t '=dev:'");
    });

    it.each([
      ['option is unset (exit 1)', { stdout: '', stderr: 'option not set', exitCode: 1 }],
      ['value is empty string', { stdout: '\n', stderr: '', exitCode: 0 }],
    ])('getOption returns null when %s', async (_label, result) => {
      runner.exec.mockResolvedValueOnce(result);
      expect(await tmux.getOption('dev', '@baxian-agent-id')).toBeNull();
    });
  });

  describe('sendKeysToPane / sendKeysLiteral (pane id without `=` prefix)', () => {
    it('sendKeysToPane targets raw pane id and quotes each key', async () => {
      await tmux.sendKeysToPane('%0', 'C-c');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('tmux send-keys');
      expect(cmd).toContain("-t '%0'");
      expect(cmd).not.toContain("'=%0'");
    });

    it('sendKeysToPane forwards multiple key tokens (e.g., text + Enter)', async () => {
      await tmux.sendKeysToPane('%0', 'echo hi', 'Enter');
      const cmd = lastCmd(runner);
      expect(cmd).toContain("'echo hi'");
      expect(cmd).toContain("'Enter'");
    });

    it('sendKeysLiteral uses send-keys -l (literal mode, no key parsing)', async () => {
      await tmux.sendKeysLiteral('%0', 'literal-text');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('tmux send-keys -l');
      expect(cmd).toContain("-t '%0'");
      expect(cmd).toContain("'literal-text'");
    });

    it('sendKeysToPane is a noop when keys are empty (no exec)', async () => {
      await tmux.sendKeysToPane('%0');
      expect(runner.exec).not.toHaveBeenCalled();
    });
  });

  describe('clearComposerDraft (dirty-then-C-c: safe on empty and drafted composers)', () => {
    it('injects a literal space before C-c so C-c always hits a non-empty composer', async () => {
      await tmux.clearComposerDraft('%0');
      const cmds = runner.exec.mock.calls.map(c => String(c[0]));
      expect(cmds).toHaveLength(2);
      expect(cmds[0]).toContain('tmux send-keys -l');
      expect(cmds[0]).toContain("-t '%0'");
      expect(cmds[0]).toContain("' '");
      expect(cmds[1]).toContain('tmux send-keys');
      expect(cmds[1]).toContain("'C-c'");
      expect(cmds[1]).not.toContain('send-keys -l');
    });

    it('propagates failure when the space injection fails (no blind C-c on unknown composer)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'no such pane', exitCode: 1 });
      await expect(tmux.clearComposerDraft('%0')).rejects.toThrow(/sendKeysLiteral/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendKeys (raw session-name target; prefer sendKeysToPane in new code)', () => {
    it('sends `keys + Enter` to the session via raw target', async () => {
      await tmux.sendKeys('dev', 'claude -p "hi"');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('tmux send-keys');
      expect(cmd).toContain("-t 'dev'");
      expect(cmd).toContain('Enter');
    });
  });

  describe('capturePaneById', () => {
    it('default flags: -p -J (no ANSI for v1 plain preview)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'content\n', stderr: '', exitCode: 0 });
      await tmux.capturePaneById('%0');
      const cmd = lastCmd(runner);
      expect(cmd).toContain('-p');
      expect(cmd).toContain('-J');
      expect(cmd).not.toMatch(/(^|\s)-e(\s|$)/);
      expect(cmd).toContain("-t '%0'");
    });

    it('opts.ansi=true adds -e (ANSI escape passthrough)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      await tmux.capturePaneById('%0', { ansi: true });
      const cmd = lastCmd(runner);
      expect(cmd).toMatch(/(^|\s)-e(\s|$)/);
    });

    it('opts.scrollback>0 adds -S -<n>', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      await tmux.capturePaneById('%0', { scrollback: 2000 });
      const cmd = lastCmd(runner);
      expect(cmd).toContain('-S');
      expect(cmd).toContain('-2000');
    });
  });

  describe('injectPrompt (paste-buffer + bracketed paste with named buffer)', () => {
    it('emits a single composite command: load-buffer + paste-buffer', async () => {
      await tmux.injectPrompt('%0', 'hello world', 'dev-1');
      expect(runner.exec).toHaveBeenCalledTimes(1);
      const cmd = lastCmd(runner);
      expect(cmd).toContain('printf');
      expect(cmd).toContain('openssl base64 -d -A');
      expect(cmd).toContain('tmux load-buffer');
      expect(cmd).toContain('tmux paste-buffer');
      expect(cmd).toContain("-t '%0'");
      expect(cmd).toMatch(/baxian-dev-1-[0-9a-f-]{36}/);
      expect(cmd).toMatch(/-d -p -r/);
    });

    it('rejects on paste-buffer non-zero exit (concrete error message)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'paste failed', exitCode: 5 });
      await expect(tmux.injectPrompt('%0', 'x', 'dev-1')).rejects.toThrow(/paste failed/);
    });

    it('accepts a prompt at exactly 80KB (boundary inside the cap)', async () => {
      const cap = 80 * 1024;
      const prompt = 'x'.repeat(cap);
      await expect(tmux.injectPrompt('%0', prompt, 'dev-1')).resolves.toBeUndefined();
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('rejects a prompt over 80KB before issuing any tmux command (deterministic error)', async () => {
      const cap = 80 * 1024;
      const prompt = 'x'.repeat(cap + 1);
      await expect(tmux.injectPrompt('%0', prompt, 'dev-1')).rejects.toThrow(/prompt too large/);
      expect(runner.exec).not.toHaveBeenCalled();
    });
  });

  describe('capturePaneSnapshot', () => {
    it('runs capture-pane + display-message in a single shell exec (atomic snapshot)', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: composeSnapStdout('\x1b[32mready\x1b[0m\nline two\n', 42),
        stderr: '', exitCode: 0,
      });
      const snap = await tmux.capturePaneSnapshot('%0');
      expect(runner.exec).toHaveBeenCalledTimes(1);
      const cmd = lastCmd(runner);
      expect(cmd).toContain('capture-pane');
      expect(cmd).toContain('display-message');
      expect(cmd).toContain('#{history_size}');
      expect(snap).toContain('ready');
      expect(snap).toContain('line two');
      expect(snap).not.toContain('\x1b[');
      expect(snap).toContain('---history_size:42---');
    });

    it('throws when the shell command exits non-zero', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'pane gone', exitCode: 1 });
      await expect(tmux.capturePaneSnapshot('%0')).rejects.toThrow(/capturePaneSnapshot.*pane gone/);
    });

    it('throws if the separator is missing (defensive against tmux/shell drift)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'visible only\n42\n', stderr: '', exitCode: 0 });
      await expect(tmux.capturePaneSnapshot('%0')).rejects.toThrow(/separator missing/);
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
      // Decouple the OSC title from runner.exec so tests overriding runner.exec for snapshot content can't leak into pane_title reads.
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
      await expect(tmux.waitSubmitAck('%0', baseline, 'claude-code', { timeoutMs: 1500, intervalMs: 50 }))
        .resolves.toBeUndefined();
    });

    it('acks via the OSC-title working spinner when in-pane content stays unrecognized-as-busy (narrow/wrapped pane)', async () => {
      const baseline = buildBaseline('› Run /review\n  gpt-5.5 xhigh · ~/repo\n', 0);
      primeTitle('~/repo');        // baseline: idle title
      primeTitle('⠹ Reviewing');   // OSC spinner appears once the runtime starts working
      await expect(tmux.waitSubmitAck('%0', baseline, 'codex', { timeoutMs: 1500, intervalMs: 50 }))
        .resolves.toBeUndefined();
    });

    it('rejects (busy baseline) when the pane is ALREADY working at entry — a spinner refresh is not a fresh ack', async () => {
      const baseline = buildBaseline('› Run /review\n  gpt-5.5 xhigh · ~/repo\n', 0);
      primeTitle('⠹ Reviewing');   // already working at entry (a prior turn; narrow pane hid the in-pane busy line)
      primeTitle('⠸ Reviewing');   // spinner rotates — must NOT be read as this prompt's idle→working ack
      await expect(tmux.waitSubmitAck('%0', baseline, 'codex', { timeoutMs: 200, intervalMs: 50 }))
        .rejects.toThrow(/pane already busy at baseline/);
    });

    it('honors a caller-provided PRE-Enter baseline title: a title already working on the first post-submit read still acks', async () => {
      const baseline = buildBaseline('› Run /review\n  gpt-5.5 xhigh · ~/repo\n', 0);
      primeTitle('⠹ Reviewing'); // runtime flipped the OSC title to working immediately after Enter — the first read the loop sees
      await expect(
        tmux.waitSubmitAck('%0', baseline, 'codex', { timeoutMs: 1500, intervalMs: 50, baselineTitle: '~/repo' }),
      ).resolves.toBeUndefined();
    });

    it('does NOT ack on scrollback growth alone when the runtime never goes busy (uncommitted redraw)', async () => {
      const baseline = buildBaseline('composer still open\n', 5);
      let h = 5;
      runner.exec.mockImplementation(async () => ({ stdout: composeSnapStdout('composer still open\n', ++h), stderr: '', exitCode: 0 }));
      await expect(tmux.waitSubmitAck('%0', baseline, 'claude-code', { timeoutMs: 200, intervalMs: 50 }))
        .rejects.toThrow(/runtime ack timeout/);
    });

    it('busy baseline is non-ackable: no observable idle→busy transition (pasted prompt text looks busy)', async () => {
      const baseline = buildBaseline('do X\n  esc to interrupt\n', 3);
      let n = 0;
      runner.exec.mockImplementation(async () => ({ stdout: composeSnapStdout(`do X\n  esc to interrupt\n[Image #1] frame ${n++}\n`, 3), stderr: '', exitCode: 0 }));
      await expect(tmux.waitSubmitAck('%0', baseline, 'claude-code', { timeoutMs: 200, intervalMs: 50 }))
        .rejects.toThrow(/runtime ack timeout/);
    });

    it('codex: stale esc-to-interrupt above → prompt is NOT busy baseline (position-aware)', async () => {
      const baseline = buildBaseline('Working on it…\n  esc to interrupt\n→ baxian git:(main)\n', 0);
      primeSnapshot('· Thinking… (2s)\n→ baxian git:(main)\n', 0);
      await expect(tmux.waitSubmitAck('%0', baseline, 'codex', { timeoutMs: 1500, intervalMs: 50 }))
        .resolves.toBeUndefined();
    });

    it('codex: pasted prompt containing "Working (8s)" is NOT busy baseline', async () => {
      const baseline = buildBaseline('→ baxian git:(main)\nPlease explain this log:\nWorking (8s)\n', 0);
      primeSnapshot('· Thinking… (2s)\n  esc to interrupt\n', 0);
      await expect(tmux.waitSubmitAck('%0', baseline, 'codex', { timeoutMs: 1500, intervalMs: 50 }))
        .resolves.toBeUndefined();
    });

    it('codex: full-screen spinner high on viewport acks after Enter', async () => {
      const baseline = buildBaseline('→ baxian git:(main)\nidle prompt text\n', 0);
      const lines = ['· Thinking… (2s)', ...Array(12).fill(''), '→ baxian git:(main)'].join('\n') + '\n';
      primeSnapshot(lines, 0);
      await expect(tmux.waitSubmitAck('%0', baseline, 'codex', { timeoutMs: 1500, intervalMs: 50 }))
        .resolves.toBeUndefined();
    });

    it('throws "runtime ack timeout" when the pane stays idle (swallowed Enter)', async () => {
      const baseline = buildBaseline('idle composer\n', 0);
      runner.exec.mockResolvedValue({ stdout: composeSnapStdout('idle composer\n', 0), stderr: '', exitCode: 0 });
      await expect(tmux.waitSubmitAck('%0', baseline, 'claude-code', { timeoutMs: 200, intervalMs: 50 }))
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
        tmux.waitSubmitAck('%0', baseline, 'claude-code', { timeoutMs: 2000, intervalMs: 50, resend, resendIntervalMs: 50 }),
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
        tmux.waitSubmitAck('%0', baseline, 'claude-code', { timeoutMs: 2000, intervalMs: 50, resend, resendIntervalMs: 50 }),
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
        tmux.waitSubmitAck('%0', baseline, 'claude-code', { timeoutMs: 2000, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).resolves.toBeUndefined();
      expect(resend).toHaveBeenCalled();
    });

    it('does NOT re-send Enter while a Codex completion popup is open (Enter would insert, not submit)', async () => {
      const baseline = buildBaseline('› $baxian-pr-review\n  phase: review\n', 0);
      runner.exec.mockResolvedValue({
        stdout: composeSnapStdout('› $baxian-pr-review\n  phase: review\n\n  Press enter to insert or esc to close\n', 0),
        stderr: '',
        exitCode: 0,
      });
      const resend = vi.fn(async () => undefined);
      await expect(
        tmux.waitSubmitAck('%0', baseline, 'codex', { timeoutMs: 250, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).rejects.toThrow(/runtime ack timeout/);
      expect(resend).not.toHaveBeenCalled();
    });

    it('re-sends Enter when the prompt body quotes the popup footer but the status line is still below it', async () => {
      const held = '› $baxian-pr-review\n  note: Press enter to insert or esc to close\n\n  gpt-5.5 xhigh · ~/repo\n';
      const baseline = buildBaseline(held, 0);
      let submitted = false;
      runner.exec.mockImplementation(async () => ({
        stdout: composeSnapStdout(submitted ? '· Thinking… (2s)\n' : held, 0),
        stderr: '',
        exitCode: 0,
      }));
      const resend = vi.fn(async () => { submitted = true; });
      await expect(
        tmux.waitSubmitAck('%0', baseline, 'codex', { timeoutMs: 2000, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).resolves.toBeUndefined();
      expect(resend).toHaveBeenCalled();
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
        tmux.waitSubmitAck('%0', baseline, 'codex', { timeoutMs: 2000, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).resolves.toBeUndefined();
      expect(resend).toHaveBeenCalled();
    });

    it('detects a Codex completion popup whose footer a narrow pane wrapped across two rows', async () => {
      const baseline = buildBaseline('› $baxian-pr-review\n  phase: review\n', 0);
      runner.exec.mockResolvedValue({
        stdout: composeSnapStdout('› $baxian-pr-review\n  Build Web Apps [Plugin]\n\n  Press enter to insert or esc\n  to close\n', 0),
        stderr: '',
        exitCode: 0,
      });
      const resend = vi.fn(async () => undefined);
      await expect(
        tmux.waitSubmitAck('%0', baseline, 'codex', { timeoutMs: 250, intervalMs: 50, resend, resendIntervalMs: 50 }),
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
        tmux.waitSubmitAck('%0', baseline, 'claude-code', { timeoutMs: 250, intervalMs: 50, resend, resendIntervalMs: 50 }),
      ).rejects.toThrow(/runtime ack timeout/);
      expect(resend).not.toHaveBeenCalled();
    });
  });

  describe('captureSettledSnapshot (best-effort pre-Enter settle)', () => {
    const primeSnapshot = (visible: string, history: number): void => {
      runner.exec.mockResolvedValueOnce({
        stdout: composeSnapStdout(visible, history),
        stderr: '', exitCode: 0,
      });
    };

    it('returns the snapshot once two consecutive captures are identical', async () => {
      primeSnapshot('attaching\n', 0);
      primeSnapshot('settled\n', 0);
      primeSnapshot('settled\n', 0);
      const snap = await tmux.captureSettledSnapshot('%0', { timeoutMs: 2000, intervalMs: 10 });
      expect(snap).toBe(buildSnapshot('settled\n', 0));
    });

    it('keeps polling while the pane is still redrawing, then returns the settled snapshot', async () => {
      primeSnapshot('f1\n', 0);
      primeSnapshot('f2\n', 0);
      primeSnapshot('f3\n', 0);
      primeSnapshot('f3\n', 0);
      const snap = await tmux.captureSettledSnapshot('%0', { timeoutMs: 2000, intervalMs: 10 });
      expect(snap).toBe(buildSnapshot('f3\n', 0));
      expect(runner.exec.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('returns the latest snapshot when the pane never settles within the timeout', async () => {
      let n = 0;
      runner.exec.mockImplementation(async () => ({
        stdout: composeSnapStdout(`frame ${n++}\n`, 0),
        stderr: '', exitCode: 0,
      }));
      const snap = await tmux.captureSettledSnapshot('%0', { timeoutMs: 80, intervalMs: 20 });
      expect(snap).toMatch(/^frame \d+\n\n---history_size:0---$/);
      expect(runner.exec.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('floors a zero poll interval so it cannot busy-spin, and still settles', async () => {
      primeSnapshot('settled\n', 0);
      primeSnapshot('settled\n', 0);
      const snap = await tmux.captureSettledSnapshot('%0', { timeoutMs: 2000, intervalMs: 0 });
      expect(snap).toBe(buildSnapshot('settled\n', 0));
    });
  });

  describe('handleTrustDialog', () => {
    it('detects the claude trust dialog and sends Enter', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: 'Quick safety check\n❯ 1. Yes, I trust this folder\n',
        stderr: '', exitCode: 0,
      });
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      const answered = await tmux.handleTrustDialog('%0', 'claude-code', { timeoutMs: 1000, intervalMs: 50 });
      expect(answered).toBe(true);
      const sentKeys = runner.exec.mock.calls[1][0] as string;
      expect(sentKeys).toContain('send-keys');
      expect(sentKeys).toContain("'Enter'");
    });

    it('returns false (already past dialog) when ready anchor is already visible', async () => {
      runner.exec
        .mockResolvedValueOnce({ stdout: '⏵⏵ bypass permissions on\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '2.1.129\n', stderr: '', exitCode: 0 });
      const answered = await tmux.handleTrustDialog('%0', 'claude-code', { timeoutMs: 200, intervalMs: 50 });
      expect(answered).toBe(false);
    });

    it('returns false early for codex → prompt when runtime is running', async () => {
      runner.exec
        .mockResolvedValueOnce({ stdout: '→ baxian git:(main)\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'codex\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '→ baxian git:(main)\n', stderr: '', exitCode: 0 });
      const answered = await tmux.handleTrustDialog('%0', 'codex', { timeoutMs: 200, intervalMs: 50 });
      expect(answered).toBe(false);
    });

    it('stale shell → on first capture does not early-exit when fresh capture shows dialog', async () => {
      runner.exec
        .mockResolvedValueOnce({ stdout: '→ baxian git:(main)\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'codex\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'Do you trust the contents of this folder?\n› 1. Yes, continue\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'Do you trust the contents of this folder?\n› 1. Yes, continue\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      const answered = await tmux.handleTrustDialog('%0', 'codex', { timeoutMs: 2000, intervalMs: 50 });
      expect(answered).toBe(true);
    });

    it('does not early-exit on shell → prompt before runtime starts, then handles trust dialog', async () => {
      runner.exec
        .mockResolvedValueOnce({ stdout: '→ baxian git:(main)\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'zsh\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'Do you trust the contents of this folder?\n› 1. Yes, continue\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      const answered = await tmux.handleTrustDialog('%0', 'codex', { timeoutMs: 2000, intervalMs: 50 });
      expect(answered).toBe(true);
    });

    it('detects codex dialog text (different from claude phrasing)', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: 'Do you trust the contents of this folder?\n› 1. Yes, continue\n',
        stderr: '', exitCode: 0,
      });
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
      const answered = await tmux.handleTrustDialog('%0', 'codex', { timeoutMs: 1000, intervalMs: 50 });
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
      runner.exec.mockResolvedValueOnce({ stdout: procTitle, stderr: '', exitCode: 0 });
      runner.exec.mockResolvedValueOnce({ stdout: anchor, stderr: '', exitCode: 0 });
      await expect(
        tmux.waitReplReady('%0', runtimeKind, { timeoutMs: 1000, intervalMs: 30 }),
      ).resolves.toBeUndefined();
    });

    it('codex: does not accept an idle-prompt-shaped snippet while output continues after it', async () => {
      runner.exec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('display-message')) {
          return { stdout: 'node\n', stderr: '', exitCode: 0 };
        }
        return {
          stdout:
            'Running generated regression tests\n\n' +
            '› Find and fix a bug in @filename\n\n' +
            '  gpt-5.5 xhigh · ~/.baxian/repos/baxian-ai/baxian\n\n' +
            'Still working on the request...\n',
          stderr: '',
          exitCode: 0,
        };
      });
      await expect(
        tmux.waitReplReady('%0', 'codex', { timeoutMs: 120, intervalMs: 30 }),
      ).rejects.toThrow(/repl not ready/);
    });

    it('keeps polling when only the proc title matches (anchor still missing)', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'node\n', stderr: '', exitCode: 0 });
      runner.exec.mockResolvedValueOnce({ stdout: 'still booting\n', stderr: '', exitCode: 0 });
      runner.exec.mockResolvedValueOnce({ stdout: 'node\n', stderr: '', exitCode: 0 });
      runner.exec.mockResolvedValueOnce({
        stdout: 'permissions: YOLO mode\n',
        stderr: '', exitCode: 0,
      });
      await expect(tmux.waitReplReady('%0', 'codex', { timeoutMs: 2000, intervalMs: 30 })).resolves.toBeUndefined();
      expect(runner.exec.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('failFastOnShell:true aborts immediately when proc_current_command is a shell', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: 'zsh\n', stderr: '', exitCode: 0 });
      await expect(
        tmux.waitReplReady('%0', 'claude-code', {
          timeoutMs: 5000, intervalMs: 30, failFastOnShell: true,
        }),
      ).rejects.toThrow(/failFastOnShell/);
    });

    it.each([
      ['throws on overall timeout when anchor never appears', 'codex' as const],
      ['claude-code: pane_current_command=node never satisfies claude (node belongs to codex only)', 'claude-code' as const],
    ])('%s', async (_label, runtimeKind) => {
      runner.exec.mockResolvedValue({ stdout: 'node\n', stderr: '', exitCode: 0 });
      await expect(
        tmux.waitReplReady('%0', runtimeKind, { timeoutMs: 200, intervalMs: 50 }),
      ).rejects.toThrow(/repl not ready/);
    });

    it.each([
      ['default scrollback is 0 (visible-only) so a stale anchor in scrollback cannot satisfy ready', undefined, /-S 0/],
      ['opts.scrollback override still works for callers that want history (e.g., trust dialog)', 50, /-S -50/],
    ])('%s', async (_label, scrollback, pattern) => {
      runner.exec.mockResolvedValueOnce({ stdout: 'codex\n', stderr: '', exitCode: 0 });
      runner.exec.mockResolvedValueOnce({ stdout: 'permissions: YOLO mode\n', stderr: '', exitCode: 0 });
      await tmux.waitReplReady('%0', 'codex', { timeoutMs: 1000, intervalMs: 30, scrollback });
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
          if (cmd.includes('pane_current_command')) return { stdout: `${procTitle}\n`, stderr: '', exitCode: 0 };
          if (cmd.includes('pane_title')) return { stdout: `${title}\n`, stderr: '', exitCode: 0 };
          return { stdout: screen, stderr: '', exitCode: 0 };
        });
      }

      it('claude-code: narrow-pane reflowed idle screen (no anchor, no ❯) + "✳ " title → ready', async () => {
        mockPaneState('2.1.199', NARROW_IDLE_SCREEN, '✳ 分析 baxian 服务 DEV agent 不遵照指示问题');
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('claude-code: same narrow screen + braille working title → keeps polling to timeout', async () => {
        mockPaneState('2.1.199', NARROW_IDLE_SCREEN, '⠹ 分析 baxian 服务 DEV agent 不遵照指示问题');
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: "✳ " title does not shortcut an actively busy screen (esc to interrupt in tail)', async () => {
        mockPaneState('2.1.199', `${NARROW_IDLE_SCREEN}\nesc to interrupt\n`, '✳ 部署服务');
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: "✳ " title does not shortcut a trust dialog', async () => {
        mockPaneState(
          'claude',
          'Quick safety check\nDo you trust the files in this folder?\n1. Yes, I trust this folder\n',
          '✳ Claude Code',
        );
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('fast path is opt-in: narrow idle screen + "✳ " title still times out without the flag', async () => {
        mockPaneState('2.1.199', NARROW_IDLE_SCREEN, '✳ 分析 baxian 服务 DEV agent 不遵照指示问题');
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30 }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('codex: cwd-shaped title is not an idle signal (fast path is claude-code only)', async () => {
        mockPaneState('node', 'Still working on the request...\n', 'baxian');
        await expect(
          tmux.waitReplReady('%6', 'codex', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('timeout error carries the last observed pane title for diagnosis', async () => {
        mockPaneState('2.1.199', NARROW_IDLE_SCREEN, '⠹ 分析 baxian');
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/paneTitle=/);
      });

      it('claude-code: "✳ " title does not shortcut a visible permission prompt (do you want to proceed?)', async () => {
        mockPaneState(
          '2.1.199',
          'Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)\n',
          '✳ 清理构建产物',
        );
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: "✳ " title does not shortcut a narrow-wrapped select-option form (AskUserQuestion)', async () => {
        mockPaneState(
          '2.1.199',
          '选择合并策略：\n❯ 1. squash\n  2. rebase\n\nEnter to select ·\nEsc to cancel · Tab/arrow\nkeys to navigate\n',
          '✳ 等待合并策略选择',
        );
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: a pending-prompt phrase far above the tail does not veto an idle bottom screen', async () => {
        const history = '…上文引用：do you want to proceed? 的行为分析\n' + '正文\n'.repeat(16);
        mockPaneState('2.1.199', history + NARROW_IDLE_SCREEN, '✳ 分析报告');
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('does not read the pane title while the screen is visibly busy (sync short-circuit first)', async () => {
        mockPaneState('2.1.199', `${NARROW_IDLE_SCREEN}\nesc to interrupt\n`, '✳ 部署服务');
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
        const titleReads = runner.exec.mock.calls.filter(c => String(c[0]).includes('pane_title'));
        expect(titleReads.length).toBe(1);
      });

      it('timeout on a busy screen still reports the pane title via the failure-path fallback read', async () => {
        mockPaneState('2.1.199', `${NARROW_IDLE_SCREEN}\nesc to interrupt\n`, '⠹ 部署服务');
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/paneTitle="⠹ 部署服务"/);
      });

      it('claude-code: "✳ " title does not shortcut a legacy offer prompt (would you like to + Yes option)', async () => {
        mockPaneState(
          '2.1.199',
          'Would you like to create the release tag now?\n❯ 1. Yes\n  2. No\n',
          '✳ 发布 1.2.37',
        );
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: "✳ " title does not shortcut the transcript viewer overlay', async () => {
        mockPaneState(
          '2.1.199',
          'transcript content line\n\nctrl+o to toggle · esc to close\n',
          '✳ 分析日志',
        );
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: an offer phrase in plain prose above an idle tail does not veto the fast path', async () => {
        mockPaneState(
          '2.1.199',
          `Would you like me to run gh pr merge?\n${NARROW_IDLE_SCREEN}`,
          '✳ 收尾合并',
        );
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('claude-code: a quoted permission phrase in a finished narrow reply does not veto the fast path', async () => {
        mockPaneState(
          '2.1.199',
          `检测覆盖了 Do you want to\nproceed? 这类权限提示。\n${NARROW_IDLE_SCREEN}`,
          '✳ 补充权限检测',
        );
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('claude-code: "✳ " title does not shortcut a narrow-wrapped confirm dialog (enter to confirm)', async () => {
        mockPaneState(
          '2.1.199',
          '确认重置会话？\nEnter to confirm ·\nEsc to cancel\n',
          '✳ 会话管理',
        );
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: a leftover composer draft below a quoted offer phrase does not veto the fast path', async () => {
        mockPaneState(
          '2.1.199',
          `表单文案 "would you like to" 已覆盖。\n${NARROW_IDLE_SCREEN}\n❯ run tests\n`,
          '✳ 跑测试收尾',
        );
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 1000, intervalMs: 30, titleIdleFastPath: true }),
        ).resolves.toBeUndefined();
      });

      it('claude-code: "✳ " title does not shortcut a permission prompt with bare unnumbered Yes options', async () => {
        mockPaneState(
          '2.1.199',
          'Do you want to proceed?\nYes\nNo\n',
          '✳ 执行构建脚本',
        );
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });

      it('claude-code: "✳ " title does not shortcut a tall pending form whose offer sits above the tail window', async () => {
        mockPaneState(
          '2.1.199',
          '─'.repeat(40) + '\nWould you like to apply this plan?\n' + 'plan detail\n'.repeat(16) + '❯ 1. Yes\n  2. No\n',
          '✳ 制定实施计划',
        );
        await expect(
          tmux.waitReplReady('%6', 'claude-code', { timeoutMs: 150, intervalMs: 30, titleIdleFastPath: true }),
        ).rejects.toThrow(/repl not ready/);
      });
    });
  });

  describe('readPaneTitle', () => {
    it('reads pane title via display-message #{pane_title}', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: '⠋ Reading file\n', stderr: '', exitCode: 0,
      });
      const title = await tmux.readPaneTitle('%1');
      expect(lastCmd(runner)).toBe("tmux display-message -p -t '%1' '#{pane_title}'");
      expect(title).toBe('⠋ Reading file');
    });

    it('returns empty string on failure', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: '', stderr: 'pane not found', exitCode: 1,
      });
      const title = await tmux.readPaneTitle('%1');
      expect(title).toBe('');
    });
  });

  describe('classifyPaneForAdopt', () => {
    const SEP = '___bx-classify-sep___';
    const composeProbeOut = (procTitle: string, capture: string): string =>
      `${procTitle}\n${SEP}\n${capture}`;

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
      runner.exec.mockResolvedValueOnce({
        stdout: composeProbeOut(procTitle, capture),
        stderr: '', exitCode: 0,
      });
      const result = await tmux.classifyPaneForAdopt('%0', runtimeKind);
      expect(result).toEqual({ kind: expectedKind });
    });

    it('codex+node: also adopts as live-runtime — session claim check is the boundary, no in-pane process verification', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: composeProbeOut('node', '› next prompt\n'),
        stderr: '', exitCode: 0,
      });
      const result = await tmux.classifyPaneForAdopt('%0', 'codex');
      expect(result).toEqual({ kind: 'live-runtime' });
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('returns "shell" for shells outside the original whitelist (dash/ksh/nu) — recovery path must not refuse them', async () => {
      for (const sh of ['dash', 'ksh', 'nu']) {
        runner.exec.mockResolvedValueOnce({
          stdout: composeProbeOut(sh, '$ \n'),
          stderr: '', exitCode: 0,
        });
        const result = await tmux.classifyPaneForAdopt('%0', 'codex');
        expect(result).toEqual({ kind: 'shell' });
      }
    });

    it('returns "other" when foreground is a non-runtime non-shell process (vim) — does NOT trip dialog regex from buffer text', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: composeProbeOut('vim', 'README excerpt: Press enter to continue.\n'),
        stderr: '', exitCode: 0,
      });
      const result = await tmux.classifyPaneForAdopt('%0', 'codex');
      expect(result.kind).toBe('other');
      if (result.kind === 'other') {
        expect(result.paneCurrentCommand).toBe('vim');
      }
    });

    it('returns "startup-dialog" only when procTitle matches runtime AND dialog text is visible', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: composeProbeOut('codex', 'Update available\nPress enter to continue\n'),
        stderr: '', exitCode: 0,
      });
      const result = await tmux.classifyPaneForAdopt('%0', 'codex');
      expect(result.kind).toBe('startup-dialog');
      if (result.kind === 'startup-dialog') {
        expect(result.lastScreen).toContain('Press enter to continue');
      }
    });

    it('codex auth screen is a startup dialog only for codex runtime', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: composeProbeOut(
          'codex',
          'Welcome to Codex\nSign in with ChatGPT\nProvide your own API key\n',
        ),
        stderr: '', exitCode: 0,
      });
      const result = await tmux.classifyPaneForAdopt('%0', 'codex');
      expect(result.kind).toBe('startup-dialog');
    });

    it('throws when separator is missing in tmux output (parse error)', async () => {
      runner.exec.mockResolvedValueOnce({
        stdout: 'codex\nincomplete output\n',
        stderr: '', exitCode: 0,
      });
      await expect(tmux.classifyPaneForAdopt('%0', 'codex')).rejects.toThrow(/separator missing/);
    });
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
