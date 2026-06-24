import { randomUUID } from 'node:crypto';
import type { CommandRunner, ExecOptions, ExecResult } from './runner.js';
import { shellQuote, SshRunner } from './runner.js';

const run = (runner: CommandRunner, cmd: string, opts?: ExecOptions): Promise<ExecResult> =>
  runner['exec'](cmd, opts);

const MAX_PROMPT_BYTES = 80 * 1024;

export type AgentRuntimeKind = 'claude-code' | 'codex';

export interface PaneInfo {
  paneId: string;
  current: string;
}

export interface CapturePaneOpts {
  ansi?: boolean;
  scrollback?: number;
  timeoutMs?: number;
}

export interface WaitOpts {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface WaitReplReadyOpts extends WaitOpts {
  failFastOnShell?: boolean;
  scrollback?: number;
  perCommandTimeoutMs?: number;
}

export interface WaitSubmitAckOpts extends WaitOpts {
  resend?: () => Promise<void>;
  resendIntervalMs?: number;
  // Treat any change away from the pre-Enter composer as proof of submission (not only a busy frame).
  // For meta-commands like /clear that redraw the screen instead of going busy, the cleared composer is
  // the submission evidence; a swallowed Enter leaves the composer unchanged and still triggers resend.
  acceptComposerChange?: boolean;
}

// claude shows semver on linux / `claude.exe` on macOS; `node` is codex-only.
const REPL_PROC_TITLES: Record<AgentRuntimeKind, RegExp> = {
  'claude-code': /^(?:claude(?:\.exe)?|\d+\.\d+\.\d+)$/,
  codex: /^(?:codex|node)$/,
};

const READY_ANCHORS: Record<AgentRuntimeKind, RegExp> = {
  'claude-code': /⏵⏵ bypass permissions on/,
  codex: /permissions: YOLO mode|(?:^|\n)› [^\n]+\n\n\s+[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._:/-]*){0,2}\s+·[^\n]*(?:\n\s*)?$/,
};

// Question + option must co-occur — either alone could appear in normal output.
const TRUST_DIALOGS: Record<AgentRuntimeKind, RegExp> = {
  'claude-code': /Quick safety check[\s\S]{0,500}Yes, I trust this folder/,
  codex: /Do you trust the contents[\s\S]{0,500}Yes, continue/,
};

// Detection only — operator dismisses; auto-answer would override product decisions.
const STARTUP_DIALOG_SIGNALS: readonly RegExp[] = [
  /Press (?:enter|return|any key) to (?:continue|proceed)/i,
  /Enter to confirm[^\n]{0,40}Esc to cancel/i,
  /Auto-updating(?:\s*(?:…|\.\.\.)|\b(?!-))/im,
];

const RUNTIME_STARTUP_DIALOG_SIGNALS: Partial<Record<AgentRuntimeKind, readonly RegExp[]>> = {
  codex: [
    /Welcome to Codex[\s\S]{0,300}?Sign in with ChatGPT[\s\S]{0,300}?Provide your own API key/i,
    /Update ran successfully[\s\S]{0,200}?Please restart Codex/i,
  ],
};

export function detectStartupDialog(stripped: string, runtime?: AgentRuntimeKind): boolean {
  if (STARTUP_DIALOG_SIGNALS.some(re => re.test(stripped))) return true;
  if (!runtime) return false;
  return RUNTIME_STARTUP_DIALOG_SIGNALS[runtime]?.some(re => re.test(stripped)) ?? false;
}

// Anchored footer "Enter to … · … Esc to": the "·" hint separator survives mid-footer mangling (overflow-overlay / narrow pane clobbers the verbs + "cancel" tail) yet rules out comma-style prose ("Enter to continue, Esc to abort").
const RUNTIME_MENU_SIGNALS: readonly RegExp[] = [
  /^[ \t]*Enter to\b[^\n]{0,160}·[^\n]{0,40}\bEsc to\b/im,
];

export function detectRuntimeMenu(stripped: string): boolean {
  return RUNTIME_MENU_SIGNALS.some(re => re.test(stripped));
}

export function hasReplReadyAnchor(stripped: string, runtime: AgentRuntimeKind): boolean {
  return READY_ANCHORS[runtime].test(stripped);
}

export function hasReplProcTitle(current: string, runtime: AgentRuntimeKind): boolean {
  return REPL_PROC_TITLES[runtime].test(current);
}

const ESC_TO_INTERRUPT_TAIL_LINES = 8;
const CLAUDE_IDLE_COMPOSER_TAIL_LINES = 6;
const ESC_TO_INTERRUPT_RE = /esc to interru(?:pt|p(?:…|\.{3})?)/i;
const CODEX_WORKING_LINE_RE = /^[ \t]*(?:[•·][ \t]+)?Working[ \t]*\(/im;
const CODEX_IDLE_PROMPT_LINE_RE = /^[ \t]*[›→](?:[ \t].*)?$/im;
const CODEX_IDLE_COMPOSER_LINE_RE = /(?:^|\n)→ [A-Za-z0-9][\w.-]*(?:\s+git:\([^\s)]+\))?\s*$/i;
const CODEX_IDLE_PROMPT_TAIL_LINES = 6;
const CODEX_WORKING_TAIL_LINES = 8;
const CLAUDE_IDLE_COMPOSER_LINE_RE = /^[ \t]*[❯>][ \t]*$/m;

// A live, incomplete spinner ("· Verb… (Ns"): its elapsed-seconds advance every second, so the
// captured screen mutates between polls during genuine work. A FROZEN spinner across polls is thus a
// reliable "runtime stuck" signal — unlike a static "esc to interrupt" anchor, which a long-running
// Codex task keeps on screen while perfectly healthy.
export function hasActiveSpinner(stripped: string): boolean {
  for (const m of stripped.matchAll(SPINNER_LINE_RE)) {
    if (!COMPLETION_MARKER_RE.test(stripped.slice(m.index + m[0].length))) return true;
  }
  return false;
}

// Stuck-busy needs the spinner in the ACTIVE region — the activity line that sits just above the
// status footer — NOT high in scrollback: a quoted/leftover "· Verb… (Ns)" on an otherwise-idle
// screen (its "Worked for" marker scrolled off) must not escalate to a STUCK_BUSY error.
// Window = footer (~5 lines) + the activity line(s) above it.
const ACTIVE_SPINNER_TAIL_LINES = 10;

export function hasActiveSpinnerInTail(stripped: string): boolean {
  const lines = stripped.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - ACTIVE_SPINNER_TAIL_LINES)).join('\n');
  return hasActiveSpinner(tail);
}

function tail(stripped: string, count: number): string {
  const paneLines = stripped.split('\n');
  return paneLines.slice(Math.max(0, paneLines.length - count)).join('\n');
}

function escToInterruptInTail(stripped: string): boolean {
  return ESC_TO_INTERRUPT_RE.test(tail(stripped, ESC_TO_INTERRUPT_TAIL_LINES));
}

export function detectReplActiveBusy(stripped: string): boolean {
  return hasActiveSpinner(stripped) || escToInterruptInTail(stripped);
}

function lastMatchIndex(stripped: string, pattern: RegExp): number {
  let last = -1;
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  for (const m of stripped.matchAll(new RegExp(pattern.source, flags))) {
    if (m.index !== undefined) last = m.index;
  }
  return last;
}

function lastIdlePromptIndex(stripped: string, runtime?: AgentRuntimeKind): number {
  if (runtime === 'codex') return lastMatchIndex(stripped, CODEX_IDLE_PROMPT_LINE_RE);
  if (runtime === 'claude-code') return lastMatchIndex(stripped, CLAUDE_IDLE_COMPOSER_LINE_RE);
  return -1;
}

function escToInterruptActiveInTail(stripped: string, runtime?: AgentRuntimeKind): boolean {
  const activeTail = tail(stripped, ESC_TO_INTERRUPT_TAIL_LINES);
  const lastEsc = lastMatchIndex(activeTail, ESC_TO_INTERRUPT_RE);
  if (lastEsc < 0) return false;
  return lastEsc > lastIdlePromptIndex(activeTail, runtime);
}

function codexWorkingInTail(stripped: string, runtime?: AgentRuntimeKind): boolean {
  if (runtime !== 'codex') return false;
  const activeTail = tail(stripped, CODEX_WORKING_TAIL_LINES);
  const lastWorking = lastMatchIndex(activeTail, CODEX_WORKING_LINE_RE);
  if (lastWorking < 0) return false;
  return lastWorking > lastIdlePromptIndex(activeTail, runtime);
}

export function detectActiveRegionBusy(stripped: string, runtime?: AgentRuntimeKind): boolean {
  return hasActiveSpinnerInTail(stripped)
    || escToInterruptActiveInTail(stripped, runtime)
    || codexWorkingInTail(stripped, runtime);
}

export function hasRuntimeIdleComposerPrompt(stripped: string, runtime: AgentRuntimeKind): boolean {
  if (runtime === 'claude-code') {
    return CLAUDE_IDLE_COMPOSER_LINE_RE.test(tail(stripped, CLAUDE_IDLE_COMPOSER_TAIL_LINES));
  }
  if (runtime === 'codex') {
    return CODEX_IDLE_COMPOSER_LINE_RE.test(tail(stripped, CODEX_IDLE_PROMPT_TAIL_LINES));
  }
  return false;
}

export function hasRuntimeReadyView(stripped: string, runtime: AgentRuntimeKind): boolean {
  if (hasReplReadyAnchor(stripped, runtime)) return true;
  if (!hasRuntimeIdleComposerPrompt(stripped, runtime)) return false;
  if (runtimeBusyCheck(stripped, runtime)) return false;
  if (detectRuntimeMenu(stripped)) return false;
  if (detectStartupDialog(stripped, runtime)) return false;
  if (TRUST_DIALOGS[runtime].test(stripped)) return false;
  return true;
}

// codex: position-aware — stale busy above → prompt is not active
// claude-code: full-screen spinner — can sit above ❯ composer in tall panes
export function runtimeBusyCheck(stripped: string, runtime: AgentRuntimeKind): boolean {
  return runtime === 'codex'
    ? detectActiveRegionBusy(stripped, runtime)
    : detectReplActiveBusy(stripped);
}

// submit-ack busy: full-screen spinner + position-aware esc-to-interrupt.
// Excludes codexWorkingInTail — pasted prompt text can contain "Working (...)"
// which must not trip the baseline check before Enter.
function submitAckBusy(stripped: string, runtime: AgentRuntimeKind): boolean {
  if (runtime === 'codex') {
    return hasActiveSpinner(stripped) || escToInterruptActiveInTail(stripped, runtime);
  }
  return detectReplActiveBusy(stripped);
}

const SPINNER_LINE_RE = /^[·✢✳✶✻✽][ \t]+[^\n…]{1,200}…[ \t]*\([ \t]*(?:\d+[ \t]*m[ \t]+)?\d+[ \t]*s/gm;
const COMPLETION_MARKER_RE = /^✻[ \t]+Worked for/m;

export type AdoptPaneState =
  | { kind: 'live-runtime' }
  | { kind: 'trust-dialog' }
  | { kind: 'startup-dialog'; lastScreen: string }
  | { kind: 'shell' }
  | { kind: 'other'; paneCurrentCommand: string };

export class ReplNotReadyError extends Error {
  constructor(
    public readonly paneId: string,
    public readonly runtime: AgentRuntimeKind,
    public readonly lastScreen: string,
    detail?: string,
  ) {
    const head = `repl not ready (paneId=${paneId}, runtime=${runtime}) within timeout`;
    const tail = lastScreen ? `\nLast pane snapshot:\n${lastScreen}` : '';
    super(detail ? `${head}: ${detail}${tail}` : `${head}${tail}`);
    this.name = 'ReplNotReadyError';
  }
}

const SHELL_PROC_TITLES = /^(?:zsh|bash|sh|fish|dash|ash|ksh|mksh|tcsh|csh|nu|xonsh|pwsh)$/;

const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, '');

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// Floor for poll loops so an explicit intervalMs of 0 can't spin the shell.
const MIN_POLL_INTERVAL_MS = 50;

const HISTORY_SUFFIX_RE = /\n---history_size:\d+---$/;
function stripHistorySuffix(snapshot: string): string {
  return snapshot.replace(HISTORY_SUFFIX_RE, '');
}

export class TmuxManager {
  constructor(private runner: CommandRunner) {}

  static async probeTmuxVersion(
    runner: CommandRunner,
  ): Promise<{ major: number; minor: number }> {
    const result = await runner.exec('tmux -V');
    if (result.exitCode !== 0) {
      throw new Error(`tmux -V failed (exit ${result.exitCode}): ${result.stderr || 'unknown error'}`);
    }
    const match = /tmux\s+(?:next-)?(\d+)\.(\d+)/.exec(result.stdout);
    if (!match) {
      throw new Error(`unparseable tmux -V output: ${JSON.stringify(result.stdout)}`);
    }
    return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
  }

  // PATH literal — fish would corrupt the colon form on $PATH expansion.
  async createSession(name: string, workdir: string): Promise<void> {
    const PATH = '/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    const result = await run(
      this.runner,
      // -x 80: stays in sync with PaneStreamer.DEFAULT_COLS (the headless buffer) — see note there.
      `tmux new-session -d -s ${shellQuote(name)} ` +
        `-e ${shellQuote(`PATH=${PATH}`)} ` +
        `-x 80 -y 50 -c ${shellQuote(workdir)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create tmux session ${name}: ${result.stderr}`);
    }
  }

  async sendInput(name: string, data: string): Promise<void> {
    if (data.length === 0) return;
    const bufName = `bx-input-${randomUUID()}`;
    const payload = Buffer.from(data, 'utf8');
    const loadCmd = `tmux load-buffer -b ${shellQuote(bufName)} -`;
    const pasteCmd = `tmux paste-buffer -d -b ${shellQuote(bufName)} -t ${shellQuote(`=${name}:`)}`;
    const deleteCmd = `tmux delete-buffer -b ${shellQuote(bufName)}`;

    try {
      const r1 = this.runner instanceof SshRunner
        ? await this.runner.execRawRemoteWithStdin(loadCmd, payload)
        : await this.runner.execWithStdin(loadCmd, payload);
      if (r1.exitCode !== 0) {
        throw new Error(`tmux sendInput ${name} load-buffer failed: ${r1.stderr || 'unknown error'}`);
      }
      const r2 = await run(this.runner, pasteCmd);
      if (r2.exitCode !== 0) {
        throw new Error(`tmux sendInput ${name} paste-buffer failed: ${r2.stderr || 'unknown error'}`);
      }
    } finally {
      // -d skips delete on paste failure; force explicit delete to avoid leak.
      await run(this.runner, deleteCmd).catch(() => undefined);
    }
  }

  async resizeWindow(name: string, cols: number, rows: number): Promise<void> {
    const result = await run(
      this.runner,
      `tmux resize-window -t ${shellQuote(`=${name}`)} -x ${cols} -y ${rows}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tmux resizeWindow ${name} failed: ${result.stderr}`);
    }
  }

  async killSession(name: string): Promise<void> {
    const result = await run(
      this.runner,
      `tmux kill-session -t ${shellQuote(`=${name}`)}`,
    );
    if (result.exitCode === 0) return;
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) return;
    if (result.exitCode === 255) {
      throw new Error(`tmux killSession ${name} runner error (ssh/exec layer): ${result.stderr}`);
    }
    throw new Error(`tmux killSession ${name} unexpected exit ${result.exitCode}: ${result.stderr}`);
  }

  async hasSession(name: string, opts?: ExecOptions): Promise<boolean> {
    const result = await run(
      this.runner,
      `tmux has-session -t ${shellQuote(`=${name}`)}`,
      opts,
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) return false;
    if (result.exitCode === 255) {
      throw new Error(`tmux hasSession ${name} runner error (ssh/exec layer): ${result.stderr}`);
    }
    throw new Error(`tmux hasSession ${name} unexpected exit ${result.exitCode}: ${result.stderr}`);
  }

  async listPanes(name: string, opts?: ExecOptions): Promise<PaneInfo[]> {
    const result = await run(
      this.runner,
      `tmux list-panes -t ${shellQuote(`=${name}`)} -F '#{pane_id} #{pane_current_command}'`,
      opts,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tmux listPanes ${name} failed: ${result.stderr}`);
    }
    return result.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const idx = line.indexOf(' ');
        return idx === -1
          ? { paneId: line, current: '' }
          : { paneId: line.slice(0, idx), current: line.slice(idx + 1) };
      });
  }

  async getSinglePaneId(name: string, opts?: ExecOptions): Promise<string> {
    const panes = await this.listPanes(name, opts);
    if (panes.length === 0) {
      throw new Error(`tmux session ${name} has no panes`);
    }
    if (panes.length > 1) {
      throw new Error(
        `tmux session ${name} has ${panes.length} panes; baxian expects exactly one — external split-window not supported`,
      );
    }
    return panes[0].paneId;
  }

  async displayMessage(paneId: string, fmt: string, opts?: ExecOptions): Promise<string> {
    const result = await run(
      this.runner,
      `tmux display-message -p -t ${shellQuote(paneId)} ${shellQuote(fmt)}`,
      opts,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tmux displayMessage ${paneId} failed: ${result.stderr}`);
    }
    return result.stdout.replace(/\n$/, '');
  }

  async readPaneTitle(paneId: string, opts?: ExecOptions): Promise<string> {
    try {
      return await this.displayMessage(paneId, '#{pane_title}', opts);
    } catch {
      return '';
    }
  }

  async setOption(name: string, key: string, value: string): Promise<void> {
    const result = await run(
      this.runner,
      `tmux set-option -t ${shellQuote(`=${name}:`)} ${shellQuote(key)} ${shellQuote(value)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tmux setOption ${name} ${key} failed: ${result.stderr}`);
    }
  }

  async setServerOption(key: string, value: string): Promise<void> {
    const result = await run(
      this.runner,
      `tmux set-option -s ${shellQuote(key)} ${shellQuote(value)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tmux setServerOption ${key} failed: ${result.stderr}`);
    }
  }

  // grep -F gate prevents `set -sa` from duplicating on repeat calls.
  async appendServerOptionIfMissing(key: string, value: string): Promise<void> {
    const result = await run(
      this.runner,
      `(tmux show-option -s -v ${shellQuote(key)} 2>/dev/null | ` +
        `grep -qF ${shellQuote(value)}) || ` +
        `tmux set-option -sa ${shellQuote(key)} ${shellQuote(value)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `tmux appendServerOptionIfMissing ${key} failed: ${result.stderr}`,
      );
    }
  }

  async getOption(name: string, key: string): Promise<string | null> {
    const result = await run(
      this.runner,
      `tmux show-option -t ${shellQuote(`=${name}:`)} -v ${shellQuote(key)}`,
    );
    if (result.exitCode === 0) {
      const trimmed = result.stdout.replace(/\n$/, '');
      return trimmed === '' ? null : trimmed;
    }
    if (result.exitCode === 1) return null;
    throw new Error(`tmux getOption ${name} ${key} unexpected exit ${result.exitCode}: ${result.stderr}`);
  }

  async sendKeysToPane(paneId: string, ...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const args = keys.map(k => shellQuote(k)).join(' ');
    const result = await run(
      this.runner,
      `tmux send-keys -t ${shellQuote(paneId)} ${args}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tmux sendKeys ${paneId} failed: ${result.stderr}`);
    }
  }

  async sendKeysLiteral(paneId: string, text: string): Promise<void> {
    const result = await run(
      this.runner,
      `tmux send-keys -l -t ${shellQuote(paneId)} ${shellQuote(text)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tmux sendKeysLiteral ${paneId} failed: ${result.stderr}`);
    }
  }

  /** Prefer {@link sendKeysToPane}. */
  async sendKeys(name: string, keys: string): Promise<void> {
    const result = await run(
      this.runner,
      `tmux send-keys -t ${shellQuote(name)} ${shellQuote(keys)} Enter`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tmux sendKeys ${name} failed: ${result.stderr}`);
    }
  }

  async capturePaneById(paneId: string, opts: CapturePaneOpts = {}): Promise<string> {
    const ansi = opts.ansi ?? false;
    const scrollback = opts.scrollback;
    const flags: string[] = ['-p', '-J'];
    if (ansi) flags.push('-e');
    if (typeof scrollback === 'number' && scrollback > 0) {
      flags.push('-S', `-${scrollback}`);
    } else if (scrollback === 0) {
      flags.push('-S', '0');
    }
    const execOpts = opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined;
    const result = await run(
      this.runner,
      `tmux capture-pane ${flags.join(' ')} -t ${shellQuote(paneId)}`,
      execOpts,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tmux capturePane ${paneId} failed: ${result.stderr || 'unknown error'}`);
    }
    return result.stdout;
  }

  async injectPrompt(
    paneId: string,
    prompt: string,
    agentId: string,
  ): Promise<void> {
    const bytes = Buffer.byteLength(prompt, 'utf8');
    if (bytes > MAX_PROMPT_BYTES) {
      throw new Error(
        `tmux injectPrompt ${paneId} prompt too large: ${bytes} bytes > ${MAX_PROMPT_BYTES}`,
      );
    }
    const promptB64 = Buffer.from(prompt, 'utf8').toString('base64');
    const buf = `baxian-${agentId}-${randomUUID()}`;
    const cmd =
      `printf '%s' ${shellQuote(promptB64)} | openssl base64 -d -A | ` +
      `tmux load-buffer -b ${shellQuote(buf)} - && ` +
      `tmux paste-buffer -b ${shellQuote(buf)} -t ${shellQuote(paneId)} -d -p -r`;
    const result = await run(this.runner, cmd);
    if (result.exitCode !== 0) {
      throw new Error(`tmux injectPrompt ${paneId} failed: ${result.stderr}`);
    }
  }

  // Visible + history_size in one command to avoid torn baselines.
  async capturePaneSnapshot(paneId: string): Promise<string> {
    const SEP = '___bx-snap-sep___';
    const cmd =
      `tmux capture-pane -t ${shellQuote(paneId)} -e -p && ` +
      `printf '%s\\n' ${shellQuote(SEP)} && ` +
      `tmux display-message -t ${shellQuote(paneId)} -p '#{history_size}'`;
    const result = await run(this.runner, cmd);
    if (result.exitCode !== 0) {
      throw new Error(`tmux capturePaneSnapshot ${paneId} failed: ${result.stderr || 'unknown error'}`);
    }
    const idx = result.stdout.lastIndexOf(`${SEP}\n`);
    if (idx < 0) {
      throw new Error(`tmux capturePaneSnapshot ${paneId}: separator missing in output`);
    }
    const visible = stripAnsi(result.stdout.slice(0, idx));
    const history = result.stdout.slice(idx + SEP.length + 1).trim();
    return `${visible}\n---history_size:${history}---`;
  }

  async sendEnter(paneId: string): Promise<void> {
    await this.sendKeysToPane(paneId, 'Enter');
  }

  // Best-effort pre-Enter settle: poll until two consecutive snapshots match (or the timeout), so an
  // async image-attach redraw is less likely to be mid-flight when Enter is sent.
  async captureSettledSnapshot(paneId: string, opts: WaitOpts = {}): Promise<string> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3_000);
    const interval = Math.max(opts.intervalMs ?? 150, MIN_POLL_INTERVAL_MS);
    let prev = await this.capturePaneSnapshot(paneId);
    while (Date.now() < deadline) {
      await sleep(interval);
      const cur = await this.capturePaneSnapshot(paneId);
      if (cur === prev) return cur;
      prev = cur;
    }
    return prev;
  }

  // Ack only on a fresh idle→busy transition (a swallowed Enter can't fake it); an already-busy baseline is non-ackable.
  // The first Enter after a bracketed paste is occasionally swallowed by the TUI's paste-end handling,
  // leaving injected text in the box needing a manual Enter. When a resend callback is given,
  // re-send Enter — but ONLY while the pane is still byte-identical to the pre-Enter composer, which is
  // the only proof the prompt is genuinely unsent.
  async waitSubmitAck(
    paneId: string,
    baseline: string,
    runtime: AgentRuntimeKind,
    opts: WaitSubmitAckOpts = {},
  ): Promise<void> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    const interval = Math.max(opts.intervalMs ?? 100, MIN_POLL_INTERVAL_MS);
    const composerBaseline = stripHistorySuffix(baseline);
    if (submitAckBusy(composerBaseline, runtime)) {
      throw new Error(`runtime ack timeout (paneId=${paneId}): pane already busy at baseline`);
    }
    const resendIntervalMs = Math.max(opts.resendIntervalMs ?? 3_000, interval);
    let lastResend = Date.now();
    while (Date.now() < deadline) {
      const visible = stripHistorySuffix(await this.capturePaneSnapshot(paneId));
      if (submitAckBusy(visible, runtime)) return;
      // For meta-commands (acceptComposerChange) a cleared/redrawn composer is itself the submission
      // proof — they may never show a busy frame.
      if (opts.acceptComposerChange && visible !== composerBaseline) return;
      // Any deviation from the pre-Enter composer (submit cleared it, or the runtime parked on a
      // menu/dialog/other UI) means a swallowed Enter is NOT the cause — and pressing Enter there
      // would answer whatever is on screen, exactly what the detect-only dialog policy forbids
      // Resend only on an unchanged composer.
      if (
        opts.resend
        && visible === composerBaseline
        && Date.now() - lastResend >= resendIntervalMs
      ) {
        await opts.resend();
        lastResend = Date.now();
      }
      await sleep(interval);
    }
    throw new Error(`runtime ack timeout (paneId=${paneId})`);
  }

  async handleTrustDialog(
    paneId: string,
    runtime: AgentRuntimeKind,
    opts: WaitOpts = {},
  ): Promise<boolean> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    const interval = opts.intervalMs ?? 500;
    const dialogPattern = TRUST_DIALOGS[runtime];
    while (Date.now() < deadline) {
      const cap = await this.capturePaneById(paneId, { ansi: true, scrollback: 50 });
      const stripped = stripAnsi(cap);
      if (dialogPattern.test(stripped)) {
        await this.sendKeysToPane(paneId, 'Enter');
        await sleep(800);
        return true;
      }
      const current = await this.displayMessage(paneId, '#{pane_current_command}');
      if (hasReplProcTitle(current, runtime)) {
        const freshStripped = stripAnsi(await this.capturePaneById(paneId, { ansi: false, scrollback: 0 }));
        if (hasRuntimeReadyView(freshStripped, runtime)) return false;
      }
      await sleep(interval);
    }
    return false;
  }

  // procTitle is authoritative (pane_pid is shell pid, not foreground); check before regexes.
  async classifyPaneForAdopt(
    paneId: string,
    runtime: AgentRuntimeKind,
    opts?: ExecOptions,
  ): Promise<AdoptPaneState> {
    const SEP = '___bx-classify-sep___';
    const result = await this.runner.exec(
      `tmux display-message -p -t ${shellQuote(paneId)} '#{pane_current_command}' ` +
        `&& printf '%s\\n' ${shellQuote(SEP)} ` +
        `&& tmux capture-pane -p -t ${shellQuote(paneId)} -e -S 0`,
      opts,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `classifyPaneForAdopt(${paneId}) tmux probe failed: ${result.stderr || 'unknown error'}`,
      );
    }
    const sepIdx = result.stdout.indexOf(SEP);
    if (sepIdx < 0) {
      throw new Error(`classifyPaneForAdopt(${paneId}): separator missing in output`);
    }
    const current = result.stdout.slice(0, sepIdx).split('\n')[0]?.trim() ?? '';
    const captureStart = result.stdout.indexOf('\n', sepIdx) + 1;
    const stripped = stripAnsi(result.stdout.slice(captureStart));

    if (REPL_PROC_TITLES[runtime].test(current)) {
      if (READY_ANCHORS[runtime].test(stripped)) return { kind: 'live-runtime' };
      if (TRUST_DIALOGS[runtime].test(stripped)) return { kind: 'trust-dialog' };
      if (detectStartupDialog(stripped, runtime)) return { kind: 'startup-dialog', lastScreen: stripped };
      return { kind: 'live-runtime' };
    }
    if (SHELL_PROC_TITLES.test(current)) return { kind: 'shell' };
    return { kind: 'other', paneCurrentCommand: current };
  }

  async waitReplReady(
    paneId: string,
    runtime: AgentRuntimeKind,
    opts: WaitReplReadyOpts = {},
  ): Promise<void> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    const interval = opts.intervalMs ?? 500;
    const failFastOnShell = opts.failFastOnShell ?? false;
    // scrollback=0: history would let a stale anchor satisfy the check.
    const scrollback = opts.scrollback ?? 0;
    const procTitle = REPL_PROC_TITLES[runtime];
    const cmdOpts = opts.perCommandTimeoutMs ? { timeout: opts.perCommandTimeoutMs } : undefined;
    let lastStripped = '';
    while (Date.now() < deadline) {
      const current = await this.displayMessage(paneId, '#{pane_current_command}', cmdOpts);
      if (failFastOnShell && SHELL_PROC_TITLES.test(current)) {
        throw new ReplNotReadyError(
          paneId,
          runtime,
          lastStripped,
          `pane_current_command=${current} (shell), failFastOnShell triggered`,
        );
      }
      const cap = await this.capturePaneById(paneId, { ansi: true, scrollback, timeoutMs: opts.perCommandTimeoutMs });
      const stripped = stripAnsi(cap);
      lastStripped = stripped;
      if (procTitle.test(current) && hasRuntimeReadyView(stripped, runtime)) return;
      await sleep(interval);
    }
    throw new ReplNotReadyError(paneId, runtime, lastStripped);
  }
}

function isSessionAbsent(stderr: string): boolean {
  // Strict whitelist — unknown stderr escalates as unexpected to avoid masking infra failures.
  const s = (stderr || '').trim().toLowerCase();
  return (
    s.includes('no server running') ||
    s.includes('session not found') ||
    s.includes("can't find session") ||
    s.includes('no such session') ||
    (s.includes('error connecting to') && s.includes('no such file or directory'))
  );
}
