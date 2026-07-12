import { randomUUID } from 'node:crypto';
import type { CommandRunner, ExecOptions, ExecResult } from './runner.js';
import { shellQuote, SshRunner } from './runner.js';
import { isHorizontalRule, tailNonEmpty } from './detect/region.js';
import { MAX_PROMPT_BYTES } from './prompt.js';

const run = (runner: CommandRunner, cmd: string, opts?: ExecOptions): Promise<ExecResult> =>
  runner['exec'](cmd, opts);

export type AgentRuntimeKind = 'claude-code' | 'codex' | 'opencode' | 'qodercli';

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
  // 宽度无关的 idle 信号兜底：窄 pane 下 Ink 硬折行会打断 anchor/composer 的屏幕正则，
  // 仅供"对运行中 REPL 等 idle"的路径开启；bootstrap 禁用（pane_title 会残留上一进程的值）。
  titleIdleFastPath?: boolean;
}

export interface WaitSubmitAckOpts extends WaitOpts {
  resend?: () => Promise<void>;
  resendIntervalMs?: number;
  acceptComposerChange?: boolean;
  // OSC title sampled by the caller BEFORE sendEnter — the idle anchor for the busy-baseline / transition check.
  baselineTitle?: string;
}

// A pattern that can never match — used where a runtime has no dialog of a given kind.
const NEVER_RE = /[^\s\S]/;

const REPL_PROC_TITLES: Record<AgentRuntimeKind, RegExp> = {
  'claude-code': /^(?:claude(?:\.exe)?|\d+\.\d+\.\d+)$/,
  codex: /^(?:codex|node)$/,
  // qodercli's npm bin reports a versioned process name (e.g. qodercli-1.0.40); the standalone binary may not.
  opencode: /^opencode$/,
  qodercli: /^qodercli(?:-[\d.]+)?$/,
};

const READY_ANCHORS: Record<AgentRuntimeKind, RegExp> = {
  'claude-code': /⏵⏵ bypass permissions on/,
  codex: /permissions: YOLO mode|(?:^|\n)› [^\n]+\n\n\s+[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._:/-]*){0,2}\s+·[^\n]*(?:\n\s*)?$/,
  // opencode/qodercli have no idle-only anchor line (their footers persist while working);
  // readiness for them is decided by the idle-composer + not-busy path in hasRuntimeReadyView.
  opencode: NEVER_RE,
  qodercli: NEVER_RE,
};

const TRUST_DIALOGS: Record<AgentRuntimeKind, RegExp> = {
  'claude-code': /Quick safety check[\s\S]{0,500}Yes, I trust this folder/,
  codex: /Do you trust the contents[\s\S]{0,500}Yes, continue/,
  opencode: NEVER_RE,
  qodercli: /Do you trust the files in this folder[\s\S]{0,500}Trust folder/,
};

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
  qodercli: [
    /Welcome to Qoder CLI[\s\S]{0,200}?Sign in to continue/i,
  ],
};

export function detectStartupDialog(stripped: string, runtime?: AgentRuntimeKind): boolean {
  if (STARTUP_DIALOG_SIGNALS.some(re => re.test(stripped))) return true;
  if (!runtime) return false;
  return RUNTIME_STARTUP_DIALOG_SIGNALS[runtime]?.some(re => re.test(stripped)) ?? false;
}

const RUNTIME_MENU_SIGNALS: readonly RegExp[] = [
  /^[ \t]*Enter to\b[^\n]{0,160}·[^\n]{0,40}\bEsc to\b/im,
];

export function detectRuntimeMenu(stripped: string): boolean {
  return RUNTIME_MENU_SIGNALS.some(re => re.test(stripped));
}

const RUNTIME_COMPLETION_POPUP_RE = /\benter to insert\b[^\n]{0,40}\besc to close\b/i;
const COMPLETION_POPUP_FOOTER_LINES = 3;
function detectRuntimeCompletionPopup(stripped: string, runtime: AgentRuntimeKind): boolean {
  if (runtime !== 'codex') return false;
  const lines = stripped.split('\n');
  const footer: string[] = [];
  for (let i = lines.length - 1; i >= 0 && footer.length < COMPLETION_POPUP_FOOTER_LINES; i--) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (line.includes('·')) break;
    footer.unshift(line);
  }
  return RUNTIME_COMPLETION_POPUP_RE.test(footer.join(' '));
}

// codex 空 composer 上按一次 Esc 会 arm backtrack，footer 变成此提示、替换掉带 `·` 的状态行；
// 它只在空闲态出现（工作中 Esc 是打断），故等价于一个 ready anchor。锚定屏幕底部避免误吃历史输出。
const CODEX_BACKTRACK_HINT_RE = /(?:^|\n)[ \t]*esc again to edit previous message[ \t]*(?:\n[ \t]*)*$/i;

function hasReplReadyAnchor(stripped: string, runtime: AgentRuntimeKind): boolean {
  if (READY_ANCHORS[runtime].test(stripped)) return true;
  return runtime === 'codex' && CODEX_BACKTRACK_HINT_RE.test(stripped);
}

const OSC_TITLE_WORKING_RE = /^[⠀-⣿] /;
export function hasOscTitleWorking(paneTitle: string): boolean {
  return OSC_TITLE_WORKING_RE.test(paneTitle);
}

// claude-code 独有契约（poller manifest osc_title_idle 同源）：idle 恒为 "✳ <摘要>"，working 为 braille 帧前缀。
// codex 的 title 是 cwd 之类的弱信号，不构成 idle 契约。
const OSC_TITLE_IDLE_RES: Partial<Record<AgentRuntimeKind, RegExp>> = {
  'claude-code': /^✳ /,
};

export function hasOscTitleIdle(paneTitle: string, runtime: AgentRuntimeKind): boolean {
  return OSC_TITLE_IDLE_RES[runtime]?.test(paneTitle) ?? false;
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
// claude-code ≥2.1 的空 composer 行是 ❯ + no-break space（U+00A0），[ \t] 不含它
const CLAUDE_IDLE_COMPOSER_LINE_RE = /^[ \t\u00A0]*[❯>][ \t\u00A0]*$/m;
// opencode working: progress bar `■■■⬝⬝⬝` + interrupt hint. Matches the herdr-listed
// "esc to interrupt", the post-TUI-rewrite "esc interrupt" (no "to"), and the
// "ctrl+c to interrupt" footer that can be the only busy evidence if the bar wraps out of tail.
const OPENCODE_BUSY_RE = /(?:esc|ctrl\+c)\s+(?:to\s+)?interrupt|(?:■|⬝){4,}/i;
const OPENCODE_IDLE_COMPOSER_RE = /ctrl\+p\s+commands/;
// qodercli working: "(esc to cancel," suffix + braille "Thinking…" spinner line.
const QODER_BUSY_RE = /\(esc to cancel,|^[ \t]*[⠀-⣿][ \t]+.*\p{L}/mu;
// Only the composer placeholder marks idle. "? for shortcuts" is dropped on purpose: it is also
// an OVERLAY_FOOTER_SIGNAL (help/shortcuts overlay), so using it as an idle cue would read an
// overlay pane as ready and paste the prompt into the overlay instead of the composer.
const QODER_IDLE_COMPOSER_RE = /Type your message or @/;
// opencode/qodercli keep their idle footer visible while a permission prompt is up, so the
// footer-based idle-composer check alone would read a pending pane as ready. Block the ready
// view on the prompt text. Kept in sync with each manifest's pending rule (opencode.json
// permission_required, qodercli.json confirmation_blocker) so ready gate and detection never
// diverge. Misfire only degrades to a dispatch timeout (fail-closed), never an inject over a live prompt.
const RUNTIME_PENDING_RES: Partial<Record<AgentRuntimeKind, RegExp>> = {
  opencode: /△\s*Permission required|Permission required|Allow once|Allow always/i,
  qodercli: /Permission Required|Allow this command to run|Do you want to allow|waiting for user confirmation|awaiting approval|allow once or always\?|asking user|enter your response|review your answers:|shell awaiting input/i,
};

export function hasActiveSpinner(stripped: string): boolean {
  for (const m of stripped.matchAll(SPINNER_LINE_RE)) {
    if (!COMPLETION_MARKER_RE.test(stripped.slice(m.index + m[0].length))) return true;
  }
  return false;
}

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

function bottomNonBlankLine(stripped: string): string {
  const lines = stripped.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') return lines[i];
  }
  return '';
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

function detectActiveRegionBusy(stripped: string, runtime?: AgentRuntimeKind): boolean {
  return hasActiveSpinnerInTail(stripped)
    || escToInterruptActiveInTail(stripped, runtime)
    || codexWorkingInTail(stripped, runtime);
}

const CODEX_EMPTY_COMPOSER_RE = /(?:^|\n)[ \t]*›[ \t]*(?:\n[ \t]*)*$/;

export function hasRuntimeIdleComposerPrompt(stripped: string, runtime: AgentRuntimeKind): boolean {
  if (runtime === 'claude-code') {
    return CLAUDE_IDLE_COMPOSER_LINE_RE.test(tail(stripped, CLAUDE_IDLE_COMPOSER_TAIL_LINES));
  }
  if (runtime === 'codex') {
    const t = tail(stripped, CODEX_IDLE_PROMPT_TAIL_LINES);
    return CODEX_IDLE_COMPOSER_LINE_RE.test(t) || CODEX_EMPTY_COMPOSER_RE.test(t);
  }
  // opencode/qodercli 的 fresh 屏顶部锚定/垂直居中，idle 标记落在物理 tail 之外（下方是空行海），
  // 取非空行窗口（与 manifest region tailNonEmpty 同语义）做到几何无关。
  if (runtime === 'opencode') {
    return OPENCODE_IDLE_COMPOSER_RE.test(tailNonEmpty(stripped, ACTIVE_SPINNER_TAIL_LINES));
  }
  if (runtime === 'qodercli') {
    return QODER_IDLE_COMPOSER_RE.test(tailNonEmpty(stripped, ACTIVE_SPINNER_TAIL_LINES));
  }
  return false;
}

function screenBlocksReadyView(stripped: string, runtime: AgentRuntimeKind): boolean {
  return runtimeBusyCheck(stripped, runtime)
    || detectRuntimeMenu(stripped)
    || detectStartupDialog(stripped, runtime)
    || TRUST_DIALOGS[runtime].test(stripped)
    || (RUNTIME_PENDING_RES[runtime]?.test(stripped) ?? false)
    || detectRuntimeOverlay(stripped);
}

// manifest blocker 规则（bash/generic permission、live_blocked_form、dynamic workflow、legacy）的文本指纹。
// 这些 prompt 挂起时 OSC 标题仍是 ✳ idle 形态（manifest 里 blocker 优先级压过 osc_title_idle 即此语义），
// 单短语 ≤22 字符，29 列窄 pane 下不折行。仅供 title fast path 消费：并入 hasRuntimeReadyView 会让
// 历史输出里的这些短语误伤 bootstrap 等既有调用方。误拦仅退化为超时 409（fail-closed），
// 但可能出现在回复正文的短语一律走组合判定（与选单形态同现）——裸判会把常态 idle 输出当 prompt。
// 指纹一律用 \s+ 连接词间：Ink 在词边界硬折行，长短语（skip interview…35 字符）窄屏必断行
const PENDING_PROMPT_SIGNALS: readonly RegExp[] = [
  /waiting\s+for\s+permission/i,
  /review\s+your\s+answers/i,
  /skip\s+interview\s+and\s+plan\s+immediately/i,
];
const PENDING_OFFER_RE = /do\s+you\s+want\s+to|would\s+you\s+like\s+to|tab\s+to\s+amend|ctrl\+e\s+to\s+explain/i;
// manifest bash/generic permission 的选项行形态并集：裸 Yes（反色选中无 ❯）、编号 Yes/No。
// 不收 `❯ <任意文本>`（legacy manifest 形态）：clear 的 pre-clear wait 发生在清残稿之前，
// composer 残稿正是 ❯+文本，收了会把修复目标场景 veto 成死锁。
const PENDING_OPTION_LINE_RE = /^\s*(?:❯\s*)?(?:\d+\.\s*)?yes\b|^\s*(?:❯\s*)?\d+\.\s*no\b/im;
const SELECT_FORM_ENTER_RE = /enter\s+to\s+(?:select|confirm)/i;
const DYNAMIC_WORKFLOW_RE = /run\s+a\s+dynamic\s+workflow\?/i;
const FORM_ESC_CANCEL_RE = /esc\s+to\s+cancel/i;
const PENDING_PROMPT_TAIL_LINES = 15;

// 活动 form 区域：最后一条水平线（form/composer box 边界）之后；无水平线（如极窄 pane 不渲染
// box）时退回 tail 15。不学 extractRegion 的"无线取整屏"——这里误拦即 409，整屏会把正文引用扫进来。
function pendingPromptRegion(stripped: string): string {
  const lines = stripped.split('\n');
  let lastRule = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isHorizontalRule(lines[i])) lastRule = i;
  }
  if (lastRule >= 0) return lines.slice(lastRule + 1).join('\n');
  return tail(stripped, PENDING_PROMPT_TAIL_LINES);
}

export function detectRuntimePendingPrompt(stripped: string): boolean {
  const t = pendingPromptRegion(stripped);
  if (PENDING_PROMPT_SIGNALS.some(re => re.test(t))) return true;
  if (PENDING_OFFER_RE.test(t) && PENDING_OPTION_LINE_RE.test(t)) return true;
  if (DYNAMIC_WORKFLOW_RE.test(t) && FORM_ESC_CANCEL_RE.test(t)) return true;
  return SELECT_FORM_ENTER_RE.test(t) && FORM_ESC_CANCEL_RE.test(t);
}

// transcript viewer / model picker 挂起时按键落 overlay 而非 composer；与 manifest skipStateUpdate 规则同源。
// footer（ctrl+o to toggle · esc to close，31 字符）窄屏会折两行，故看最后 2 个非空行而非 manifest 的 1 行。
const OVERLAY_FOOTER_SIGNALS: readonly RegExp[] = [
  /ctrl\+o[^\n]{0,60}to\s+toggle/i,
  /ctrl\+e[^\n]{0,60}show\s+all/i,
  /ctrl\+e[^\n]{0,60}collapse/i,
  /showing\s+detailed\s+transcript/i,
  /↑↓\s+scroll/,
  /\?\s+for\s+shortcuts/,
];
const OVERLAY_FOOTER_NONBLANK_LINES = 2;
const MODEL_PICKER_TITLE_RE = /select\s+model/i;
const MODEL_PICKER_FOOTER_RE = /enter\s+to\s+set\s+as\s+default/i;

function lastNonBlankLines(stripped: string, count: number): string {
  const kept: string[] = [];
  const lines = stripped.split('\n');
  for (let i = lines.length - 1; i >= 0 && kept.length < count; i--) {
    if (lines[i].trim() !== '') kept.unshift(lines[i]);
  }
  return kept.join('\n');
}

export function detectRuntimeOverlay(stripped: string): boolean {
  const footer = lastNonBlankLines(stripped, OVERLAY_FOOTER_NONBLANK_LINES);
  if (OVERLAY_FOOTER_SIGNALS.some(re => re.test(footer))) return true;
  const t = tail(stripped, PENDING_PROMPT_TAIL_LINES);
  return MODEL_PICKER_TITLE_RE.test(t) && MODEL_PICKER_FOOTER_RE.test(t);
}

export function screenAllowsTitleIdle(stripped: string, runtime: AgentRuntimeKind): boolean {
  return !screenBlocksReadyView(stripped, runtime)
    && !detectRuntimePendingPrompt(stripped)
    && !detectRuntimeOverlay(stripped);
}

export function hasRuntimeReadyView(stripped: string, runtime: AgentRuntimeKind): boolean {
  if (hasReplReadyAnchor(stripped, runtime)) return true;
  if (!hasRuntimeIdleComposerPrompt(stripped, runtime)) return false;
  return !screenBlocksReadyView(stripped, runtime);
}

export function runtimeBusyCheck(stripped: string, runtime: AgentRuntimeKind): boolean {
  if (runtime === 'codex') return detectActiveRegionBusy(stripped, runtime);
  if (runtime === 'opencode') return OPENCODE_BUSY_RE.test(tailNonEmpty(stripped, ACTIVE_SPINNER_TAIL_LINES));
  if (runtime === 'qodercli') return QODER_BUSY_RE.test(tailNonEmpty(stripped, ACTIVE_SPINNER_TAIL_LINES));
  return detectReplActiveBusy(stripped);
}

function submitAckBusy(stripped: string, runtime: AgentRuntimeKind): boolean {
  if (runtime === 'codex') {
    return hasActiveSpinner(stripped) || escToInterruptActiveInTail(stripped, runtime);
  }
  if (runtime === 'opencode') return OPENCODE_BUSY_RE.test(tailNonEmpty(stripped, ACTIVE_SPINNER_TAIL_LINES));
  if (runtime === 'qodercli') return QODER_BUSY_RE.test(tailNonEmpty(stripped, ACTIVE_SPINNER_TAIL_LINES));
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

const MIN_POLL_INTERVAL_MS = 50;
const COMPOSER_DIRTY_SETTLE_MS = 200;

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

  async createSession(name: string, workdir: string): Promise<void> {
    const PATH = '/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    const result = await run(
      this.runner,
      `tmux new-session -d -s ${shellQuote(name)} ` +
        `-e ${shellQuote(`PATH=${PATH}`)} ` +
        `-x 200 -y 50 -c ${shellQuote(workdir)}`,
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

  async getPaneCurrentPath(paneId: string, opts?: ExecOptions): Promise<string> {
    const path = await this.displayMessage(paneId, '#{pane_current_path}', opts);
    if (path === '') throw new Error(`tmux pane ${paneId} has an empty current path`);
    return path;
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

  // 空格先弄脏 composer——空 composer 上 C-c 会退出 codex；间隔防止连发被 codex 粘贴检测合并。
  async clearComposerDraft(paneId: string): Promise<void> {
    await this.sendKeysLiteral(paneId, ' ');
    await sleep(COMPOSER_DIRTY_SETTLE_MS);
    await this.sendKeysToPane(paneId, 'C-c');
  }

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
    // Width-independent busy authority: at narrow width the in-pane "working" line soft-wraps out of regex range, but the OSC title still transitions idle→working. Prefer the caller's PRE-Enter sample; reading here would race a runtime that flips to working right after submit.
    const baselineTitle = opts.baselineTitle ?? await this.readPaneTitle(paneId);
    if (hasOscTitleWorking(baselineTitle)) {
      throw new Error(`runtime ack timeout (paneId=${paneId}): pane already busy at baseline`);
    }
    const resendIntervalMs = Math.max(opts.resendIntervalMs ?? 3_000, interval);
    let lastResend = Date.now();
    while (Date.now() < deadline) {
      const visible = stripHistorySuffix(await this.capturePaneSnapshot(paneId));
      if (submitAckBusy(visible, runtime)) return;
      const title = await this.readPaneTitle(paneId);
      if (hasOscTitleWorking(title) && title !== baselineTitle) return;
      if (opts.acceptComposerChange && visible !== composerBaseline) return;
      const bottomLine = bottomNonBlankLine(visible);
      const enterWouldSubmit =
        !detectRuntimeMenu(bottomLine)
        && !detectStartupDialog(bottomLine, runtime)
        && !TRUST_DIALOGS[runtime].test(visible)
        && !detectRuntimeCompletionPopup(visible, runtime)
        // opencode/qodercli can open a permission/confirmation prompt right after submit,
        // before any busy spinner. Resending Enter there would hit the default option
        // (e.g. Allow once), so treat a pending prompt as "already left the composer".
        && !(RUNTIME_PENDING_RES[runtime]?.test(visible) ?? false)
        // 非 YOLO 下 claude-code 的权限 prompt 底行（Esc to cancel · Tab to amend…）不落上面任何
        // 守卫；区域限定的 pending 指纹兜底，误伤只退化为 ack 超时（fail-closed），绝不 Enter 进 prompt。
        && !detectRuntimePendingPrompt(visible);
      if (
        opts.resend
        && enterWouldSubmit
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
    const scrollback = opts.scrollback ?? 0;
    const procTitle = REPL_PROC_TITLES[runtime];
    const cmdOpts = opts.perCommandTimeoutMs ? { timeout: opts.perCommandTimeoutMs } : undefined;
    let lastStripped = '';
    let lastTitle: string | undefined;
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
      if (procTitle.test(current)) {
        if (hasRuntimeReadyView(stripped, runtime)) return;
        if (opts.titleIdleFastPath && screenAllowsTitleIdle(stripped, runtime)) {
          lastTitle = await this.readPaneTitle(paneId, cmdOpts);
          if (hasOscTitleIdle(lastTitle, runtime)) return;
        }
      }
      await sleep(interval);
    }
    if (opts.titleIdleFastPath && lastTitle === undefined) {
      lastTitle = await this.readPaneTitle(paneId, cmdOpts);
    }
    throw new ReplNotReadyError(
      paneId,
      runtime,
      lastStripped,
      lastTitle === undefined ? undefined : `paneTitle=${JSON.stringify(lastTitle)}`,
    );
  }
}

function isSessionAbsent(stderr: string): boolean {
  const s = (stderr || '').trim().toLowerCase();
  return (
    s.includes('no server running') ||
    s.includes('session not found') ||
    s.includes("can't find session") ||
    s.includes('no such session') ||
    (s.includes('error connecting to') && s.includes('no such file or directory'))
  );
}
