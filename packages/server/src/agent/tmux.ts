import { randomUUID } from 'node:crypto';
import type { CommandRunner, ExecOptions, ExecResult } from './runner.js';
import { shellQuote } from './runner.js';
import { execOutcomeUnknown, isTransientNetworkFailure } from './net-exec.js';
import { isHorizontalRule, tailNonEmpty } from './detect/region.js';
import { MAX_PROMPT_BYTES } from './prompt.js';

const run = (runner: CommandRunner, cmd: string, opts?: ExecOptions): Promise<ExecResult> =>
  runner['exec'](cmd, opts);

export type AgentRuntimeKind = 'claude-code' | 'codex' | 'opencode' | 'qodercli';

// $n is reused across tmux server restarts; the ref pins the server generation too.
export interface TmuxSessionRef {
  sessionId: string;
  serverPid: string;
  serverStart: string;
}

export interface TmuxSessionSnapshot {
  ref: TmuxSessionRef;
  claim: string | null;
}

export type KillSessionOutcome = 'killed' | 'absent' | 'refused';

// The claim condition a kill must prove server-side, in the same command as the kill itself.
export type KillClaimCond =
  | { kind: 'unclaimed' }
  | { kind: 'equals'; claim: string }
  | { kind: 'emptyOr'; claim: string };

export const CREATION_NONCE_ENV = 'BAXIAN_CREATION_NONCE';
const SESSION_REF_FORMAT = '#{pid}|#{start_time}|#{session_id}';
const REFUSED_MARKER = 'BX_KILL_REFUSED';
const TARGET_GONE_MARKER = 'BX_TARGET_GONE';
const PANE_OK_MARKER = 'BX_PANE_OK';

// %n and $n are reused by a fresh server; every pane op re-proves generation+session+pane+claim
// inside the executing server itself.
export interface PaneRef {
  session: TmuxSessionRef;
  paneId: string;
  claim: string;
}

export class PaneGoneError extends Error {
  constructor(public readonly target: string, detail: string) {
    super(`tmux target ${target} is gone or no longer owned: ${detail}`);
    this.name = 'PaneGoneError';
  }
}

export class TmuxOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxOutcomeUnknownError';
  }
}

function assertPaneId(paneId: string): void {
  if (!/^%\d+$/.test(paneId)) {
    throw new Error(`tmux: malformed pane id ${JSON.stringify(paneId)}`);
  }
}

function assertPaneRef(pane: PaneRef): void {
  assertSessionRef(pane.session);
  assertPaneId(pane.paneId);
  assertPlainSessionName(pane.claim);
}

function generationCond(ref: TmuxSessionRef): string {
  return `#{&&:#{==:#{pid},${ref.serverPid}},#{==:#{start_time},${ref.serverStart}}}`;
}

function sessionCond(ref: TmuxSessionRef, claim: string): string {
  return `#{&&:#{&&:${generationCond(ref)},#{==:#{session_id},${ref.sessionId}}},#{==:#{@baxian-agent-id},${claim}}}`;
}

function paneCond(pane: PaneRef): string {
  const sess = `#{&&:#{==:#{session_id},${pane.session.sessionId}},#{==:#{pane_id},${pane.paneId}}}`;
  return `#{&&:#{&&:${generationCond(pane.session)},${sess}},#{==:#{@baxian-agent-id},${pane.claim}}}`;
}

function assertPlainFormat(fmt: string): void {
  if (fmt.includes("'") || fmt.includes('\n')) {
    throw new Error(`tmux format ${JSON.stringify(fmt)} contains unsupported characters`);
  }
}

// Newline/NUL cannot survive tmux command re-parsing; everything else round-trips via '\'' splicing.
export function tmuxQuote(value: string): string {
  if (value.includes('\n') || value.includes('\0')) {
    throw new Error(`tmux argument ${JSON.stringify(value)} contains unsupported characters (newline/NUL)`);
  }
  if (value === '') return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertSessionRef(ref: TmuxSessionRef): void {
  if (!/^\$\d+$/.test(ref.sessionId) || !/^\d+$/.test(ref.serverPid) || !/^\d+$/.test(ref.serverStart)) {
    throw new Error(`tmux: malformed session ref ${JSON.stringify(ref)}`);
  }
}

function parseSessionRef(line: string): TmuxSessionRef | null {
  const m = /^(\d+)\|(\d+)\|(\$\d+)$/.exec(line.trim());
  if (!m) return null;
  return { serverPid: m[1], serverStart: m[2], sessionId: m[3] };
}

// Names land inside tmux format filters — reject syntax-altering characters outright.
function assertPlainSessionName(name: string): void {
  if (!/^[A-Za-z0-9_@=[\]-]+$/.test(name)) {
    throw new Error(`tmux session name ${JSON.stringify(name)} contains unsupported characters`);
  }
}

export interface PaneInfo {
  paneId: string;
  current: string;
}

// full: server proves format arithmetic (probe evaluates to 1) — triple ∧ claim ∧ gen guard.
// legacy: server version parses below 3.2 — triple ∧ claim guard, no numeric gen compare.
// null: unknown — owner writes are forbidden entirely (fail closed).
export type OwnerWriteCapability = 'full' | 'legacy' | null;

export interface WindowGeometry {
  width: number;
  height: number;
  statusLines: number;
  sizeMode: string;
  ownerGen: number | null;
  ref: TmuxSessionRef;
  claim: string;
  ownerWriteCapability: OwnerWriteCapability;
}

// One read carries geometry, owner state, non-reusable session identity, the
// session claim, and a feature probe evaluated by the same server that will
// evaluate write guards (plus its version for the legacy determination).
const WINDOW_GEOMETRY_FORMAT =
  '#{window_width} #{window_height} #{status} #{window-size} ' +
  '#{@bx_owner_gen}|#{pid}|#{start_time}|#{session_id}|#{@baxian-agent-id}|#{version}|#{e|<=:1,2}';

const TMUX_VERSION_RE = /^(?:next-)?(\d+)\.(\d+)/;

export function classifyOwnerWriteCapability(versionRaw: string, probeRaw: string): OwnerWriteCapability {
  if (probeRaw === '1') return 'full';
  const m = TMUX_VERSION_RE.exec(versionRaw.trim());
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (major > 3 || (major === 3 && minor >= 2)) {
    // A >=3.2 server whose arithmetic probe did NOT evaluate is contradictory
    // evidence — never downgrade it to an unguarded-adjacent path.
    return null;
  }
  return 'legacy';
}

export interface TtySize {
  cols: number;
  rows: number;
}

// A client's usable content area excludes its status line(s); tmux only keeps the
// scroll-optimized incremental stream for clients whose content area matches the
// window size, so both conversions must stay N-aware or geometry runs away.
export function contentArea(tty: TtySize, statusLines: number): TtySize {
  return { cols: tty.cols, rows: Math.max(1, tty.rows - statusLines) };
}

export function desiredTty(geometry: { width: number; height: number; statusLines: number }): TtySize {
  return { cols: geometry.width, rows: geometry.height + geometry.statusLines };
}

export function parseStatusLines(raw: string): number {
  if (raw === 'off') return 0;
  if (raw === 'on') return 1;
  if (/^[2-5]$/.test(raw)) return parseInt(raw, 10);
  throw new Error(`tmux: unrecognized status value ${JSON.stringify(raw)}`);
}

export function parseWindowGeometry(stdout: string): WindowGeometry {
  const line = stdout.replace(/\n+$/, '');
  const m = /^(\d+) (\d+) (\S+) (\S*) ([^|]*)\|(\d+)\|(\d+)\|(\$\d+)\|([^|]*)\|([^|]*)\|(.*)$/.exec(line);
  if (!m) {
    throw new Error(`tmux: unparseable window geometry ${JSON.stringify(line)}`);
  }
  const [, w, h, status, sizeMode, genRaw, pid, start, sessionId, claim, versionRaw, probeRaw] = m;
  const width = parseInt(w, 10);
  const height = parseInt(h, 10);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error(`tmux: invalid window geometry ${w}x${h}`);
  }
  let ownerGen: number | null = null;
  if (genRaw !== '') {
    const parsed = Number(genRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`tmux: invalid @bx_owner_gen ${JSON.stringify(genRaw)}`);
    }
    ownerGen = parsed;
  }
  return {
    width,
    height,
    statusLines: parseStatusLines(status),
    sizeMode,
    ownerGen,
    ref: { serverPid: pid, serverStart: start, sessionId },
    claim,
    ownerWriteCapability: classifyOwnerWriteCapability(versionRaw, probeRaw),
  };
}

export class SessionAbsentError extends Error {
  constructor(name: string, detail: string) {
    super(`tmux session ${name} is absent: ${detail}`);
    this.name = 'SessionAbsentError';
  }
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

  async createSession(name: string, workdir: string): Promise<TmuxSessionRef> {
    assertPlainSessionName(name);
    const PATH = '/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    // -e lands the nonce atomically with the session itself — the post-disconnect ownership proof.
    const nonce = randomUUID();
    let result: ExecResult;
    try {
      result = await run(
        this.runner,
        `tmux new-session -d -s ${shellQuote(name)} ` +
          `-e ${shellQuote(`PATH=${PATH}`)} ` +
          `-e ${shellQuote(`${CREATION_NONCE_ENV}=${nonce}`)} ` +
          `-x 200 -y 50 -c ${shellQuote(workdir)} ` +
          `-PF '${SESSION_REF_FORMAT}'`,
      );
    } catch (err) {
      return this.reconcileCreatedSession(
        name,
        nonce,
        `new-session exec rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (result.exitCode === 0) {
      const ref = parseSessionRef(result.stdout);
      if (ref) return ref;
      return this.reconcileCreatedSession(
        name,
        nonce,
        `new-session succeeded but returned unparseable ref ${JSON.stringify(result.stdout.trim())}`,
      );
    }
    // "No success seen" is not "not created" — a session may be live behind a dropped connection.
    if (execOutcomeUnknown(result)) {
      return this.reconcileCreatedSession(
        name,
        nonce,
        `new-session outcome unknown (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    throw new Error(`Failed to create tmux session ${name}: ${result.stderr}`);
  }

  private async reconcileCreatedSession(
    name: string,
    nonce: string,
    cause: string,
  ): Promise<TmuxSessionRef> {
    let snapshot: TmuxSessionSnapshot | null;
    try {
      snapshot = await this.getSessionSnapshot(name);
    } catch (err) {
      throw new Error(
        `tmux createSession ${name}: outcome unknown and reconcile probe failed ` +
          `(${err instanceof Error ? err.message : String(err)}); original cause: ${cause}`,
      );
    }
    if (!snapshot) {
      throw new Error(`Failed to create tmux session ${name}: ${cause}`);
    }
    let survivorNonce: string | null;
    try {
      survivorNonce = await this.readCreationNonce(name);
    } catch (err) {
      throw new Error(
        `tmux createSession ${name}: outcome unknown and nonce probe failed ` +
          `(${err instanceof Error ? err.message : String(err)}); original cause: ${cause}`,
      );
    }
    if (survivorNonce === nonce) {
      console.warn(`[tmux] createSession ${name}: reconciled after uncertain outcome (${cause})`);
      return snapshot.ref;
    }
    throw new Error(
      `tmux session ${name} exists but was not created by this call (nonce mismatch) — leaving it untouched; cause: ${cause}`,
    );
  }

  private async readCreationNonce(name: string, opts?: ExecOptions): Promise<string | null> {
    assertPlainSessionName(name);
    const result = await run(
      this.runner,
      `tmux show-environment -t ${shellQuote(`=${name}:`)} ${CREATION_NONCE_ENV}`,
      opts,
    );
    if (result.exitCode === 0) {
      const line = result.stdout.trim();
      return line.startsWith(`${CREATION_NONCE_ENV}=`) ? line.slice(CREATION_NONCE_ENV.length + 1) : null;
    }
    // Transient-network / 255 markers on either stream must NOT be read as "no nonce"; treat as unknown.
    if (tmuxProbeOutcomeUnknown(result)) {
      throw new TmuxOutcomeUnknownError(`tmux creation-nonce probe for ${name} outcome unknown (transient): exit ${result.exitCode}: ${result.stderr}`);
    }
    if (result.exitCode === 1 && (isUnknownTmuxVariable(result.stderr) || isSessionAbsent(result.stderr))) {
      return null;
    }
    throw new Error(`tmux creation-nonce probe for ${name} failed (exit ${result.exitCode}): ${result.stderr}`);
  }

  // Ref and claim come from one round trip — the claim can't belong to a different session.
  async getSessionSnapshot(name: string, opts?: ExecOptions): Promise<TmuxSessionSnapshot | null> {
    assertPlainSessionName(name);
    const result = await run(
      this.runner,
      `tmux list-sessions -F '${SESSION_REF_FORMAT}|#{@baxian-agent-id}' ` +
        `-f ${shellQuote(`#{==:#{session_name},${name}}`)}`,
      opts,
    );
    if (result.exitCode === 0) {
      const line = result.stdout.trim();
      if (line === '') return null;
      const sep = line.lastIndexOf('|');
      const ref = sep === -1 ? null : parseSessionRef(line.slice(0, sep));
      if (!ref) {
        throw new Error(`tmux getSessionSnapshot ${name}: unparseable output ${JSON.stringify(line)}`);
      }
      const claim = line.slice(sep + 1);
      return { ref, claim: claim === '' ? null : claim };
    }
    if (tmuxProbeOutcomeUnknown(result)) {
      throw new TmuxOutcomeUnknownError(`tmux getSessionSnapshot ${name} outcome unknown (transient): exit ${result.exitCode}: ${result.stderr}`);
    }
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) return null;
    throw new Error(`tmux getSessionSnapshot ${name} failed (exit ${result.exitCode}): ${result.stderr}`);
  }

  async hasCreationNonce(name: string, opts?: ExecOptions): Promise<boolean> {
    return (await this.readCreationNonce(name, opts)) !== null;
  }

  // Every session-option write re-proves generation+session+claim inside the server itself;
  // expectedClaim '' is the fresh-create batch writing the claim onto a still-unclaimed session.
  async setSessionOptionsIfAlive(
    ref: TmuxSessionRef,
    entries: ReadonlyArray<readonly [string, string]>,
    opts: { expectedClaim: string },
  ): Promise<'applied' | 'gone'> {
    assertSessionRef(ref);
    if (opts.expectedClaim !== '') assertPlainSessionName(opts.expectedClaim);
    if (entries.length === 0) return 'applied';
    const sets = entries
      .map(([key, value]) => `set-option -t '${ref.sessionId}' ${key} ${tmuxQuote(value)}`)
      .join(' ; ');
    const result = await run(
      this.runner,
      `tmux if-shell -t ${shellQuote(ref.sessionId)} ` +
        `-F ${shellQuote(sessionCond(ref, opts.expectedClaim))} ` +
        `${shellQuote(sets)} ` +
        `${shellQuote(`display-message -p ${TARGET_GONE_MARKER}`)}`,
    );
    if (result.exitCode === 0) {
      return result.stdout.includes(TARGET_GONE_MARKER) ? 'gone' : 'applied';
    }
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) return 'gone';
    throw new Error(
      `tmux setSessionOptionsIfAlive ${ref.sessionId} failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  async getSessionOptionByRef(ref: TmuxSessionRef, claim: string, key: string): Promise<string | null> {
    assertSessionRef(ref);
    assertPlainSessionName(claim);
    assertPlainFormat(key);
    const result = await run(
      this.runner,
      `tmux if-shell -t ${shellQuote(ref.sessionId)} ` +
        `-F ${shellQuote(sessionCond(ref, claim))} ` +
        `${shellQuote(`display-message -p -t '${ref.sessionId}' '${PANE_OK_MARKER}#{${key}}'`)} ` +
        `${shellQuote(`display-message -p ${TARGET_GONE_MARKER}`)}`,
    );
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) {
      throw new PaneGoneError(ref.sessionId, result.stderr.trim());
    }
    if (result.exitCode !== 0) {
      throw new Error(`tmux getSessionOptionByRef ${ref.sessionId} ${key} failed: ${result.stderr}`);
    }
    const firstLine = result.stdout.split('\n', 1)[0];
    if (!firstLine.startsWith(PANE_OK_MARKER)) {
      throw new PaneGoneError(ref.sessionId, 'identity condition failed');
    }
    const value = firstLine.slice(PANE_OK_MARKER.length);
    return value === '' ? null : value;
  }

  // The web-terminal resize path: size change and window-size pin ride one claim-checked command.
  async resizeWindowByRef(ref: TmuxSessionRef, claim: string, cols: number, rows: number): Promise<void> {
    assertSessionRef(ref);
    assertPlainSessionName(claim);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
      throw new Error(`tmux resizeWindowByRef: invalid dimensions ${cols}x${rows}`);
    }
    const inner = `resize-window -t '${ref.sessionId}' -x ${cols} -y ${rows} ; ` +
      `set-option -t '${ref.sessionId}' window-size latest`;
    const result = await run(
      this.runner,
      `tmux if-shell -t ${shellQuote(ref.sessionId)} ` +
        `-F ${shellQuote(sessionCond(ref, claim))} ` +
        `${shellQuote(inner)} ` +
        `${shellQuote(`display-message -p ${TARGET_GONE_MARKER}`)}`,
    );
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) {
      throw new PaneGoneError(ref.sessionId, result.stderr.trim());
    }
    if (result.exitCode !== 0) {
      throw new Error(`tmux resizeWindowByRef ${ref.sessionId} failed: ${result.stderr}`);
    }
    if (result.stdout.includes(TARGET_GONE_MARKER)) {
      throw new PaneGoneError(ref.sessionId, 'identity condition failed');
    }
  }

  // list-panes -a with an exact generation+session+claim filter cannot fall back to another
  // session, and a fresh server reissuing the same $n fails the generation half.
  async getSinglePaneByRef(ref: TmuxSessionRef, claim: string, opts?: ExecOptions): Promise<PaneRef> {
    assertSessionRef(ref);
    assertPlainSessionName(claim);
    const result = await run(
      this.runner,
      `tmux list-panes -a -F '#{pane_id} #{pane_current_command}' ` +
        `-f ${shellQuote(sessionCond(ref, claim))}`,
      opts,
    );
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) {
      throw new Error(`tmux session ${ref.sessionId} is gone (no server)`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`tmux getSinglePaneByRef ${ref.sessionId} failed: ${result.stderr}`);
    }
    const panes = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    if (panes.length === 0) {
      throw new Error(`tmux session ${ref.sessionId} is gone (no panes match)`);
    }
    if (panes.length > 1) {
      throw new Error(
        `tmux session ${ref.sessionId} has ${panes.length} panes; baxian expects exactly one — external split-window not supported`,
      );
    }
    const paneId = panes[0].split(' ')[0];
    assertPaneId(paneId);
    return { session: ref, paneId, claim };
  }

  // Generation AND the caller-declared claim condition are evaluated inside the killing server itself.
  async killSessionRef(ref: TmuxSessionRef, claimCond: KillClaimCond, opts?: ExecOptions): Promise<KillSessionOutcome> {
    assertSessionRef(ref);
    let claimClause: string;
    if (claimCond.kind === 'unclaimed') {
      claimClause = '#{==:#{@baxian-agent-id},}';
    } else {
      assertPlainSessionName(claimCond.claim);
      claimClause = claimCond.kind === 'equals'
        ? `#{==:#{@baxian-agent-id},${claimCond.claim}}`
        : `#{||:#{==:#{@baxian-agent-id},},#{==:#{@baxian-agent-id},${claimCond.claim}}}`;
    }
    const cond = `#{&&:#{&&:${generationCond(ref)},#{==:#{session_id},${ref.sessionId}}},${claimClause}}`;
    const result = await run(
      this.runner,
      `tmux if-shell -t ${shellQuote(ref.sessionId)} -F ${shellQuote(cond)} ` +
        `${shellQuote(`kill-session -t '${ref.sessionId}'`)} ` +
        `${shellQuote(`display-message -p ${REFUSED_MARKER}`)}`,
      opts,
    );
    if (result.exitCode === 0) {
      return result.stdout.includes(REFUSED_MARKER) ? 'refused' : 'killed';
    }
    // Transient / 255 must not be read as "absent" — a stuck kill would otherwise let DELETE drop the session.
    if (tmuxProbeOutcomeUnknown(result)) {
      throw new TmuxOutcomeUnknownError(`tmux killSessionRef ${ref.sessionId} outcome unknown (transient): exit ${result.exitCode}: ${result.stderr}`);
    }
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) return 'absent';
    throw new Error(`tmux killSessionRef ${ref.sessionId} unexpected exit ${result.exitCode}: ${result.stderr}`);
  }

  private async guardedPaneWrite(pane: PaneRef, inner: string[], opts?: ExecOptions): Promise<void> {
    assertPaneRef(pane);
    const result = await run(
      this.runner,
      `tmux if-shell -t ${shellQuote(pane.paneId)} -F ${shellQuote(paneCond(pane))} ` +
        `${shellQuote(inner.join(' ; '))} ` +
        `${shellQuote(`display-message -p ${TARGET_GONE_MARKER}`)}`,
      opts,
    );
    if (result.exitCode === 0) {
      if (result.stdout.includes(TARGET_GONE_MARKER)) {
        throw new PaneGoneError(pane.paneId, 'identity condition failed');
      }
      return;
    }
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) {
      throw new PaneGoneError(pane.paneId, result.stderr.trim());
    }
    throw new Error(`tmux guarded write to ${pane.paneId} failed (exit ${result.exitCode}): ${result.stderr}`);
  }

  // Marker-first read: the FIRST line decides ok/gone, so pane text can never spoof the verdict.
  private async guardedPaneRead(
    pane: PaneRef,
    headerFmt: string,
    extra: string[] = [],
    opts?: ExecOptions,
  ): Promise<{ header: string; body: string }> {
    assertPaneRef(pane);
    assertPlainFormat(headerFmt);
    const inner = [
      `display-message -p -t ${pane.paneId} '${PANE_OK_MARKER}${headerFmt}'`,
      ...extra,
    ].join(' ; ');
    const result = await run(
      this.runner,
      `tmux if-shell -t ${shellQuote(pane.paneId)} -F ${shellQuote(paneCond(pane))} ` +
        `${shellQuote(inner)} ` +
        `${shellQuote(`display-message -p ${TARGET_GONE_MARKER}`)}`,
      opts,
    );
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) {
      throw new PaneGoneError(pane.paneId, result.stderr.trim());
    }
    if (result.exitCode !== 0) {
      throw new Error(`tmux guarded read of ${pane.paneId} failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    const nl = result.stdout.indexOf('\n');
    const firstLine = nl === -1 ? result.stdout : result.stdout.slice(0, nl);
    if (!firstLine.startsWith(PANE_OK_MARKER)) {
      throw new PaneGoneError(pane.paneId, 'identity condition failed');
    }
    return {
      header: firstLine.slice(PANE_OK_MARKER.length),
      body: nl === -1 ? '' : result.stdout.slice(nl + 1),
    };
  }

  // Absent / transient / other failures are distinct outcomes: SSH flakes and
  // exit 255 must never be read as "session gone" (three-state discipline).
  async getWindowGeometry(name: string, opts?: ExecOptions): Promise<WindowGeometry> {
    assertPlainSessionName(name);
    const result = await run(
      this.runner,
      `tmux display-message -p -t ${shellQuote(`=${name}:`)} ${shellQuote(WINDOW_GEOMETRY_FORMAT)}`,
      opts,
    );
    if (result.exitCode === 0) return parseWindowGeometry(result.stdout);
    if (tmuxProbeOutcomeUnknown(result)) {
      throw new TmuxOutcomeUnknownError(`tmux getWindowGeometry ${name} outcome unknown (transient): exit ${result.exitCode}: ${result.stderr}`);
    }
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) {
      throw new SessionAbsentError(name, result.stderr.trim());
    }
    throw new Error(`tmux getWindowGeometry ${name} failed (exit ${result.exitCode}): ${result.stderr}`);
  }

  // The guard re-evaluates identity + claim (+ generation when the server proves
  // format arithmetic) inside the tmux server at execution time: a delayed write —
  // stale gen, a same-name session rebuilt after ours died, or a foreign/unclaimed
  // same-name session — lands as a no-op instead of mutating a window we don't own.
  async ownerWrite(
    name: string,
    ref: TmuxSessionRef,
    claim: string,
    gen: number | null,
    mode: 'manual' | 'latest',
    resizeTo: { cols: number; rows: number } | undefined,
    opts?: ExecOptions,
  ): Promise<void> {
    assertPlainSessionName(name);
    assertSessionRef(ref);
    assertPlainSessionName(claim);
    if (gen !== null && (!Number.isSafeInteger(gen) || gen < 0)) {
      throw new Error(`tmux ownerWrite ${name}: invalid generation ${gen}`);
    }
    const target = `=${name}:`;
    const identityAndClaim = sessionCond(ref, claim);
    const guard = gen === null
      ? identityAndClaim
      : `#{&&:${identityAndClaim},#{?#{@bx_owner_gen},#{e|<=:#{@bx_owner_gen},${gen}},1}}`;
    const actions = [
      ...(gen !== null ? [`set-option -t "${target}" @bx_owner_gen ${gen}`] : []),
      `set-option -t "${target}" window-size ${mode}`,
      ...(resizeTo ? [`resize-window -t "${target}" -x ${resizeTo.cols} -y ${resizeTo.rows}`] : []),
    ].join(' ; ');
    const result = await run(
      this.runner,
      `tmux if-shell -F -t ${shellQuote(target)} ${shellQuote(guard)} ${shellQuote(actions)} ''`,
      opts,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tmux ownerWrite ${name} failed (exit ${result.exitCode}): ${result.stderr}`);
    }
  }

  async hasSession(name: string, opts?: ExecOptions): Promise<boolean> {
    const result = await run(
      this.runner,
      `tmux has-session -t ${shellQuote(`=${name}`)}`,
      opts,
    );
    if (result.exitCode === 0) return true;
    if (tmuxProbeOutcomeUnknown(result)) {
      throw new TmuxOutcomeUnknownError(`tmux hasSession ${name} outcome unknown (transient): exit ${result.exitCode}: ${result.stderr}`);
    }
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) return false;
    throw new Error(`tmux hasSession ${name} unexpected exit ${result.exitCode}: ${result.stderr}`);
  }

  async displayMessage(pane: PaneRef, fmt: string, opts?: ExecOptions): Promise<string> {
    const { header } = await this.guardedPaneRead(pane, fmt, [], opts);
    return header;
  }

  async getPaneCurrentPath(pane: PaneRef, opts?: ExecOptions): Promise<string> {
    const path = await this.displayMessage(pane, '#{pane_current_path}', opts);
    if (path === '') throw new Error(`tmux pane ${pane.paneId} has an empty current path`);
    return path;
  }

  // A gone pane reads as an empty title on purpose: title is an advisory signal, never an authority.
  async readPaneTitle(pane: PaneRef, opts?: ExecOptions): Promise<string> {
    try {
      return await this.displayMessage(pane, '#{pane_title}', opts);
    } catch {
      return '';
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

  async sendKeysToPane(pane: PaneRef, ...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.guardedPaneWrite(pane, [
      `send-keys -t ${pane.paneId} ${keys.map(k => tmuxQuote(k)).join(' ')}`,
    ]);
  }

  async sendKeysLiteral(pane: PaneRef, text: string): Promise<void> {
    await this.guardedPaneWrite(pane, [
      `send-keys -l -t ${pane.paneId} ${tmuxQuote(text)}`,
    ]);
  }

  async capturePaneById(pane: PaneRef, opts: CapturePaneOpts = {}): Promise<string> {
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
    const { body } = await this.guardedPaneRead(
      pane,
      '',
      [`capture-pane ${flags.join(' ')} -t ${pane.paneId}`],
      execOpts,
    );
    return body;
  }

  // Probe-gated stdin load (bytes reach a buffer only on a five-field identity match, no openssl) then a claim-checked paste; once the load is confirmed, any paste non-success reconciles the named buffer so nothing leaks.
  async injectPrompt(pane: PaneRef, prompt: string, agentId: string): Promise<void> {
    assertPaneRef(pane);
    const bytes = Buffer.byteLength(prompt, 'utf8');
    if (bytes > MAX_PROMPT_BYTES) {
      throw new Error(
        `tmux injectPrompt ${pane.paneId} prompt too large: ${bytes} bytes > ${MAX_PROMPT_BYTES}`,
      );
    }
    const buf = `baxian-${agentId}-${randomUUID()}`;
    const payload = Buffer.from(prompt, 'utf8');
    const probeFmt = '#{pid}|#{start_time}|#{session_id}|#{pane_id}|#{@baxian-agent-id}';
    const expected = [
      pane.session.serverPid, pane.session.serverStart, pane.session.sessionId,
      pane.paneId, pane.claim,
    ].join('|');
    const loadCmd =
      `[ "$(tmux display-message -p -t ${shellQuote(pane.paneId)} '${probeFmt}')" = ${shellQuote(expected)} ] && ` +
      `tmux load-buffer -b ${shellQuote(buf)} -`;
    // Step 1 — probe-gated load via execWithStdin (login-shell PATH resolves tmux); a failed gate/load leaves NO buffer, only an unknown outcome reconciles.
    let loaded: ExecResult;
    try {
      loaded = await this.runner.execWithStdin(loadCmd, payload);
    } catch (err) {
      await this.reconcileInjectBuffer(buf, `load exec rejected: ${err instanceof Error ? err.message : String(err)}`);
      throw new Error(
        `tmux injectPrompt ${pane.paneId} failed (load exec layer): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (loaded.exitCode !== 0) {
      if (execOutcomeUnknown(loaded)) {
        await this.reconcileInjectBuffer(buf, `load outcome unknown (exit ${loaded.exitCode}): ${loaded.stderr.trim()}`);
        throw new Error(`tmux injectPrompt ${pane.paneId} load outcome unknown (exit ${loaded.exitCode}): ${loaded.stderr}`);
      }
      if (isSessionAbsent(loaded.stderr)) throw new PaneGoneError(pane.paneId, loaded.stderr.trim());
      throw new PaneGoneError(
        pane.paneId,
        `identity probe or buffer load failed before any buffer was created: ${loaded.stderr.trim() || 'probe mismatch'}`,
      );
    }
    // Step 2 — the buffer now exists. Any non-success here may leave it behind → reconcile by name.
    const pasteCmd =
      `tmux if-shell -t ${shellQuote(pane.paneId)} -F ${shellQuote(paneCond(pane))} ` +
        `${shellQuote(`paste-buffer -b ${buf} -t ${pane.paneId} -d -p -r`)} ` +
        `${shellQuote(`delete-buffer -b ${buf} ; display-message -p ${TARGET_GONE_MARKER}`)}`;
    let pasted: ExecResult;
    try {
      pasted = await run(this.runner, pasteCmd);
    } catch (err) {
      await this.reconcileInjectBuffer(buf, `paste exec rejected: ${err instanceof Error ? err.message : String(err)}`);
      throw new Error(
        `tmux injectPrompt ${pane.paneId} failed (paste exec layer): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (pasted.exitCode === 0) {
      if (pasted.stdout.includes(TARGET_GONE_MARKER)) {
        throw new PaneGoneError(pane.paneId, 'identity condition failed at paste (buffer self-cleaned)');
      }
      return;
    }
    // Non-zero after a confirmed load (e.g. pane vanished before if-shell resolved -t, returning
    // "can't find pane") does NOT run the else-branch, so the buffer lingers — reconcile by name.
    await this.reconcileInjectBuffer(buf, `paste failed (exit ${pasted.exitCode}): ${pasted.stderr.trim()}`);
    if (pasted.exitCode === 1 && (isSessionAbsent(pasted.stderr) || isTargetGone(pasted.stderr))) {
      throw new PaneGoneError(pane.paneId, pasted.stderr.trim() || 'pane gone before paste');
    }
    throw new Error(`tmux injectPrompt ${pane.paneId} paste failed (exit ${pasted.exitCode}): ${pasted.stderr}`);
  }

  // The uuid buffer name is the non-rebindable credential: deleting it by name on any server removes only this call's bytes, so reconciliation ignores generation.
  private async reconcileInjectBuffer(buf: string, cause: string): Promise<void> {
    try {
      const del = await run(this.runner, `tmux delete-buffer -b ${shellQuote(buf)}`);
      if (del.exitCode === 0) {
        console.warn(`[tmux] injectPrompt reconcile: removed leftover buffer ${buf} (${cause})`);
        return;
      }
      if (del.exitCode === 1 && (isUnknownTmuxBuffer(del.stderr) || isSessionAbsent(del.stderr))) return;
      console.warn(
        `[tmux] injectPrompt reconcile: buffer ${buf} cleanup NOT confirmed ` +
          `(exit ${del.exitCode}: ${del.stderr.trim()}); prompt may linger in tmux (${cause})`,
      );
    } catch (err) {
      console.warn(
        `[tmux] injectPrompt reconcile: buffer ${buf} cleanup NOT confirmed; prompt may linger in tmux (${cause}):`,
        err,
      );
    }
  }

  // Staging split from pasting lets a caller fence the paste after every await the staging exec hides.
  async stagePromptBuffer(paneId: string, prompt: string, agentId: string): Promise<{ buf: string }> {
    const bytes = Buffer.byteLength(prompt, 'utf8');
    if (bytes > MAX_PROMPT_BYTES) {
      throw new Error(
        `tmux stagePromptBuffer ${paneId} prompt too large: ${bytes} bytes > ${MAX_PROMPT_BYTES}`,
      );
    }
    const buf = `baxian-${agentId}-${randomUUID()}`;
    const payload = Buffer.from(prompt, 'utf8');
    let result: ExecResult;
    let transportErr: unknown;
    try {
      // Raw stdin load (no openssl) — same transport as injectPrompt, keeping the guard path openssl-free.
      result = await this.runner.execWithStdin(`tmux load-buffer -b ${shellQuote(buf)} -`, payload);
    } catch (err) {
      transportErr = err;
      result = { stdout: '', stderr: '', exitCode: 255 };
    }
    if (transportErr !== undefined || result.exitCode !== 0) {
      let retirementNote = '';
      // Unknown outcome may have created the full-prompt buffer remotely; retire it by its unique name.
      if (transportErr !== undefined || execOutcomeUnknown(result)) {
        let cleanupFailure: string | undefined;
        try {
          const del = await run(this.runner, `tmux delete-buffer -b ${shellQuote(buf)}`);
          const confirmedAbsent = !execOutcomeUnknown(del) && isUnknownTmuxBuffer(del.stderr);
          if (del.exitCode !== 0 && !confirmedAbsent) {
            cleanupFailure = `delete-buffer ${del.stderr.trim() || `exit ${del.exitCode}`} (exit ${del.exitCode})`;
          }
        } catch (probeErr) {
          cleanupFailure = probeErr instanceof Error ? probeErr.message : String(probeErr);
        }
        if (cleanupFailure === undefined) {
          console.info(`[TmuxManager] stagePromptBuffer ${paneId}: retired staged buffer ${buf} after an unconfirmed load`);
        } else {
          console.warn(
            `[TmuxManager] stagePromptBuffer ${paneId}: reconciliation failed, buffer ${buf} may persist remotely: ${cleanupFailure}`,
          );
          retirementNote = `; staged buffer ${buf} may persist remotely (${cleanupFailure})`;
        }
      }
      if (transportErr !== undefined) throw transportErr;
      const unknownNote = execOutcomeUnknown(result) ? ' (outcome unknown)' : '';
      throw new Error(`tmux stagePromptBuffer ${paneId} failed${unknownNote}: ${result.stderr}${retirementNote}`);
    }
    return { buf };
  }

  async pasteStagedBuffer(paneId: string, buf: string): Promise<void> {
    const result = await run(
      this.runner,
      `tmux paste-buffer -b ${shellQuote(buf)} -t ${shellQuote(paneId)} -d -p -r`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tmux pasteStagedBuffer ${paneId} failed: ${result.stderr}`);
    }
  }

  async dropStagedBuffer(buf: string): Promise<void> {
    const result = await run(this.runner, `tmux delete-buffer -b ${shellQuote(buf)}`);
    if (result.exitCode !== 0) {
      throw new Error(`tmux dropStagedBuffer ${buf} failed: ${result.stderr}`);
    }
  }

  async capturePaneSnapshot(pane: PaneRef): Promise<string> {
    const { header, body } = await this.guardedPaneRead(
      pane,
      '|#{history_size}',
      [`capture-pane -t ${pane.paneId} -e -p`],
    );
    const history = header.replace(/^\|/, '').trim();
    return `${stripAnsi(body)}\n---history_size:${history}---`;
  }

  async sendEnter(pane: PaneRef): Promise<void> {
    await this.sendKeysToPane(pane, 'Enter');
  }

  // 空格先弄脏 composer——空 composer 上 C-c 会退出 codex；间隔防止连发被 codex 粘贴检测合并。
  async clearComposerDraft(pane: PaneRef): Promise<void> {
    await this.sendKeysLiteral(pane, ' ');
    await sleep(COMPOSER_DIRTY_SETTLE_MS);
    await this.sendKeysToPane(pane, 'C-c');
  }

  async captureSettledSnapshot(pane: PaneRef, opts: WaitOpts = {}): Promise<string> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3_000);
    const interval = Math.max(opts.intervalMs ?? 150, MIN_POLL_INTERVAL_MS);
    let prev = await this.capturePaneSnapshot(pane);
    while (Date.now() < deadline) {
      await sleep(interval);
      const cur = await this.capturePaneSnapshot(pane);
      if (cur === prev) return cur;
      prev = cur;
    }
    return prev;
  }

  async waitSubmitAck(
    pane: PaneRef,
    baseline: string,
    runtime: AgentRuntimeKind,
    opts: WaitSubmitAckOpts = {},
  ): Promise<void> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    const interval = Math.max(opts.intervalMs ?? 100, MIN_POLL_INTERVAL_MS);
    const composerBaseline = stripHistorySuffix(baseline);
    if (submitAckBusy(composerBaseline, runtime)) {
      throw new Error(`runtime ack timeout (paneId=${pane.paneId}): pane already busy at baseline`);
    }
    // Width-independent busy authority: at narrow width the in-pane "working" line soft-wraps out of regex range, but the OSC title still transitions idle→working. Prefer the caller's PRE-Enter sample; reading here would race a runtime that flips to working right after submit.
    const baselineTitle = opts.baselineTitle ?? await this.readPaneTitle(pane);
    if (hasOscTitleWorking(baselineTitle)) {
      throw new Error(`runtime ack timeout (paneId=${pane.paneId}): pane already busy at baseline`);
    }
    const resendIntervalMs = Math.max(opts.resendIntervalMs ?? 3_000, interval);
    let lastResend = Date.now();
    while (Date.now() < deadline) {
      const visible = stripHistorySuffix(await this.capturePaneSnapshot(pane));
      if (submitAckBusy(visible, runtime)) return;
      const title = await this.readPaneTitle(pane);
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
    throw new Error(`runtime ack timeout (paneId=${pane.paneId})`);
  }

  async handleTrustDialog(
    pane: PaneRef,
    runtime: AgentRuntimeKind,
    opts: WaitOpts = {},
  ): Promise<boolean> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    const interval = opts.intervalMs ?? 500;
    const dialogPattern = TRUST_DIALOGS[runtime];
    while (Date.now() < deadline) {
      const cap = await this.capturePaneById(pane, { ansi: true, scrollback: 50 });
      const stripped = stripAnsi(cap);
      if (dialogPattern.test(stripped)) {
        await this.sendKeysToPane(pane, 'Enter');
        await sleep(800);
        return true;
      }
      const current = await this.displayMessage(pane, '#{pane_current_command}');
      if (hasReplProcTitle(current, runtime)) {
        const freshStripped = stripAnsi(await this.capturePaneById(pane, { ansi: false, scrollback: 0 }));
        if (hasRuntimeReadyView(freshStripped, runtime)) return false;
      }
      await sleep(interval);
    }
    return false;
  }

  async classifyPaneForAdopt(
    pane: PaneRef,
    runtime: AgentRuntimeKind,
    opts?: ExecOptions,
  ): Promise<AdoptPaneState> {
    const { header, body } = await this.guardedPaneRead(
      pane,
      '#{pane_current_command}',
      [`capture-pane -p -t ${pane.paneId} -e -S 0`],
      opts,
    );
    const current = header.trim();
    const stripped = stripAnsi(body);

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
    pane: PaneRef,
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
      const current = await this.displayMessage(pane, '#{pane_current_command}', cmdOpts);
      if (failFastOnShell && SHELL_PROC_TITLES.test(current)) {
        throw new ReplNotReadyError(
          pane.paneId,
          runtime,
          lastStripped,
          `pane_current_command=${current} (shell), failFastOnShell triggered`,
        );
      }
      const cap = await this.capturePaneById(pane, { ansi: true, scrollback, timeoutMs: opts.perCommandTimeoutMs });
      const stripped = stripAnsi(cap);
      lastStripped = stripped;
      if (procTitle.test(current)) {
        if (hasRuntimeReadyView(stripped, runtime)) return;
        if (opts.titleIdleFastPath && screenAllowsTitleIdle(stripped, runtime)) {
          lastTitle = await this.readPaneTitle(pane, cmdOpts);
          if (hasOscTitleIdle(lastTitle, runtime)) return;
        }
      }
      await sleep(interval);
    }
    if (opts.titleIdleFastPath && lastTitle === undefined) {
      lastTitle = await this.readPaneTitle(pane, cmdOpts);
    }
    throw new ReplNotReadyError(
      pane.paneId,
      runtime,
      lastStripped,
      lastTitle === undefined ? undefined : `paneTitle=${JSON.stringify(lastTitle)}`,
    );
  }
}

function isUnknownTmuxVariable(stderr: string): boolean {
  return /unknown variable/i.test(stderr);
}

function isUnknownTmuxBuffer(stderr: string): boolean {
  return /unknown buffer|no buffer/i.test(stderr);
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

// A tmux probe outcome is UNKNOWN (not "absent") when exit 255 (ssh/exec layer) or an INDEPENDENT
// transient marker appears. The local "error connecting to <socket> (No such file)" absence itself
// matches the generic "error connecting to" transient pattern, so it is stripped before deciding —
// only a remaining genuine transient (ssh drop, connection reset, …) makes the outcome unknown.
function tmuxProbeOutcomeUnknown(result: Pick<ExecResult, 'exitCode' | 'stdout' | 'stderr'>): boolean {
  if (result.exitCode === 255) return true;
  const stderrSansSocketAbsence = (result.stderr || '').replace(
    /error connecting to \S+ \(no such file or directory\)/gi,
    '',
  );
  return isTransientNetworkFailure(stderrSansSocketAbsence) || isTransientNetworkFailure(result.stdout);
}

// A pane/window that vanished (distinct from a whole-session/server absence).
function isTargetGone(stderr: string): boolean {
  const s = (stderr || '').trim().toLowerCase();
  return /can'?t find (?:pane|window)/.test(s) || s.includes('no such pane') || s.includes('no such window');
}
