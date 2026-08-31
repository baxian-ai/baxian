import { randomUUID } from 'node:crypto';
import type { CommandRunner, ExecOptions, ExecResult } from './runner.js';
import { shellQuote } from './runner.js';
import { execOutcomeUnknown, isTransientNetworkFailure } from './net-exec.js';
import { classifyScreen, isTrustedIdleRule } from './detect/classify.js';
import type { AgentRuntimeKind, ManifestDetection } from './detect/manifest.js';
import { MAX_PROMPT_BYTES } from './prompt.js';

const run = (runner: CommandRunner, cmd: string, opts?: ExecOptions): Promise<ExecResult> =>
  runner['exec'](cmd, opts);

export type { AgentRuntimeKind };

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

export type KillClaimCond =
  | { kind: 'unclaimed' }
  | { kind: 'equals'; claim: string }
  | { kind: 'emptyOr'; claim: string };

const CREATION_NONCE_ENV = 'BAXIAN_CREATION_NONCE';
const SESSION_REF_FORMAT = '#{pid}|#{start_time}|#{session_id}';
const REFUSED_MARKER = 'BX_KILL_REFUSED';
const TARGET_GONE_MARKER = 'BX_TARGET_GONE';
const PANE_OK_MARKER = 'BX_PANE_OK';

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

function assertPlainSessionName(name: string): void {
  if (!/^[A-Za-z0-9_@=[\]-]+$/.test(name)) {
    throw new Error(`tmux session name ${JSON.stringify(name)} contains unsupported characters`);
  }
}

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

const WINDOW_GEOMETRY_FORMAT =
  '#{window_width} #{window_height} #{status} #{window-size} ' +
  '#{@bx_owner_gen}|#{pid}|#{start_time}|#{session_id}|#{@baxian-agent-id}|#{version}|#{e|<=:1,2}|#{session_id}';

const TMUX_VERSION_RE = /^(?:next-)?(\d+)\.(\d+)/;

export function classifyOwnerWriteCapability(versionRaw: string, probeRaw: string): OwnerWriteCapability {
  if (probeRaw === '1') return 'full';
  const m = TMUX_VERSION_RE.exec(versionRaw.trim());
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (major > 3 || (major === 3 && minor >= 2)) {
    return null;
  }
  return 'legacy';
}

export interface TtySize {
  cols: number;
  rows: number;
}

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
  const m = /^(\d+) (\d+) (\S+) (\S*) ([^|]*)\|(\d+)\|(\d+)\|(\$\d+)\|([^|]*)\|([^|]*)\|(.*)\|(\$\d+)$/.exec(line);
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

// The trailing #{session_id} slot sits after every user-controllable field, so smuggled '|' can never shift it.
function isNoTargetGeometryExpansion(stdout: string): boolean {
  const parts = stdout.replace(/\n+$/, '').split('|');
  return parts.length >= 8 && parts[parts.length - 1] === '';
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
  titleIdleFastPath?: boolean;
}

export interface WaitSubmitAckOpts extends WaitOpts {
  resend?: () => Promise<void>;
  resendIntervalMs?: number;
  baselineTitle?: string;
}

const NEVER_RE = /[^\s\S]/;

const REPL_PROC_TITLES: Record<AgentRuntimeKind, RegExp> = {
  'claude-code': /^(?:claude(?:\.exe)?|\d+\.\d+\.\d+)$/,
  codex: /^(?:codex|node)$/,
  opencode: /^opencode$/,
  qodercli: /^qodercli(?:-[\d.]+)?$/,
};

const READY_ANCHORS: Record<AgentRuntimeKind, RegExp> = {
  'claude-code': /⏵⏵ bypass permissions on/,
  // tmux keeps styled blank cells, so the row between composer and footer may hold whitespace
  codex: /permissions: YOLO mode|(?:^|\n)› [^\n]+\n[^\S\n]*\n\s+[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._:/-]*){0,2}\s+·[^\n]*(?:\n\s*)?$/,
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

const CODEX_BACKTRACK_HINT_RE = /(?:^|\n)[ \t]*esc again to edit previous message[ \t]*(?:\n[ \t]*)*$/i;

function hasReplReadyAnchor(stripped: string, runtime: AgentRuntimeKind): boolean {
  if (READY_ANCHORS[runtime].test(stripped)) return true;
  return runtime === 'codex' && CODEX_BACKTRACK_HINT_RE.test(stripped);
}

export function hasReplProcTitle(current: string, runtime: AgentRuntimeKind): boolean {
  return REPL_PROC_TITLES[runtime].test(current);
}

export function isShellProcTitle(current: string): boolean {
  return SHELL_PROC_TITLES.test(current);
}

// 空白 boot 屏在 manifest 下默认 idle,启动就绪必须另有 composer 正证据
const LAUNCH_COMPOSER_CUES: Record<AgentRuntimeKind, RegExp[]> = {
  'claude-code': [/(?:^|\n)[ \t\u00a0]*[❯>][ \t\u00a0]*(?:\n[ \t]*)*$/],
  codex: [
    /(?:^|\n)[ \t]*›[ \t]*(?:\n[ \t]*)*$/,
    /(?:^|\n)→ [A-Za-z0-9][\w.-]*(?:[ \t]+git:\([^\s)]+\))?[ \t]*(?:\n[ \t]*)*$/,
  ],
  opencode: [/ctrl\+p commands/],
  qodercli: [/Type your message or @/],
};

function hasLaunchReadyCue(stripped: string, runtime: AgentRuntimeKind): boolean {
  return hasReplReadyAnchor(stripped, runtime)
    || LAUNCH_COMPOSER_CUES[runtime].some(re => re.test(stripped));
}

export function hasRuntimeReadyView(
  stripped: string,
  runtime: AgentRuntimeKind,
  detection: ManifestDetection = classifyScreen(runtime, stripped),
): boolean {
  if (detection.state !== 'idle') return false;
  if (!isTrustedIdleRule(runtime, detection.matchedRuleId) && !hasLaunchReadyCue(stripped, runtime)) return false;
  return !detectStartupDialog(stripped, runtime) && !TRUST_DIALOGS[runtime].test(stripped);
}

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
    if (tmuxProbeOutcomeUnknown(result)) {
      throw new TmuxOutcomeUnknownError(`tmux creation-nonce probe for ${name} outcome unknown (transient): exit ${result.exitCode}: ${result.stderr}`);
    }
    if (result.exitCode === 1 && (isUnknownTmuxVariable(result.stderr) || isSessionAbsent(result.stderr))) {
      return null;
    }
    throw new Error(`tmux creation-nonce probe for ${name} failed (exit ${result.exitCode}): ${result.stderr}`);
  }

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
      if (!result.stdout.includes(REFUSED_MARKER)) return 'killed';
      // tmux >= 3.6 runs the else branch for a missing -t target, so REFUSED may mean absent; ids are unique per server generation, and an id reused after a restart only errs toward 'refused'.
      const probe = await run(this.runner, `tmux has-session -t ${shellQuote(ref.sessionId)}`, opts);
      if (probe.exitCode === 0) return 'refused';
      if (tmuxProbeOutcomeUnknown(probe)) {
        throw new TmuxOutcomeUnknownError(`tmux killSessionRef ${ref.sessionId} recheck outcome unknown (transient): exit ${probe.exitCode}: ${probe.stderr}`);
      }
      if (probe.exitCode === 1 && isSessionAbsent(probe.stderr)) return 'absent';
      throw new Error(`tmux killSessionRef ${ref.sessionId} recheck unexpected exit ${probe.exitCode}: ${probe.stderr}`);
    }
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

  async getWindowGeometry(name: string, opts?: ExecOptions): Promise<WindowGeometry> {
    assertPlainSessionName(name);
    const result = await run(
      this.runner,
      `tmux display-message -p -t ${shellQuote(`=${name}:`)} ${shellQuote(WINDOW_GEOMETRY_FORMAT)}`,
      opts,
    );
    if (result.exitCode === 0) {
      if (isNoTargetGeometryExpansion(result.stdout)) {
        throw new SessionAbsentError(name, `no-target expansion: ${result.stdout.trim()}`);
      }
      return parseWindowGeometry(result.stdout);
    }
    if (tmuxProbeOutcomeUnknown(result)) {
      throw new TmuxOutcomeUnknownError(`tmux getWindowGeometry ${name} outcome unknown (transient): exit ${result.exitCode}: ${result.stderr}`);
    }
    if (result.exitCode === 1 && isSessionAbsent(result.stderr)) {
      throw new SessionAbsentError(name, result.stderr.trim());
    }
    throw new Error(`tmux getWindowGeometry ${name} failed (exit ${result.exitCode}): ${result.stderr}`);
  }

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
    await this.reconcileInjectBuffer(buf, `paste failed (exit ${pasted.exitCode}): ${pasted.stderr.trim()}`);
    if (pasted.exitCode === 1 && (isSessionAbsent(pasted.stderr) || isTargetGone(pasted.stderr))) {
      throw new PaneGoneError(pane.paneId, pasted.stderr.trim() || 'pane gone before paste');
    }
    throw new Error(`tmux injectPrompt ${pane.paneId} paste failed (exit ${pasted.exitCode}): ${pasted.stderr}`);
  }

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
      result = await this.runner.execWithStdin(`tmux load-buffer -b ${shellQuote(buf)} -`, payload);
    } catch (err) {
      transportErr = err;
      result = { stdout: '', stderr: '', exitCode: 255 };
    }
    if (transportErr !== undefined || result.exitCode !== 0) {
      let retirementNote = '';
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
    const baselineTitle = opts.baselineTitle ?? await this.readPaneTitle(pane);
    // 基线是粘贴之后抓的,含用户提示词正文;它自己就判 working 时屏幕证据是用户可控的,只剩标题能作证
    const baselineWorking = classifyScreen(runtime, composerBaseline, baselineTitle).state === 'working';
    const resendIntervalMs = Math.max(opts.resendIntervalMs ?? 3_000, interval);
    let lastResend = Date.now();
    while (Date.now() < deadline) {
      const visible = stripHistorySuffix(await this.capturePaneSnapshot(pane));
      if (!baselineWorking && classifyScreen(runtime, visible).state === 'working') return;
      const title = await this.readPaneTitle(pane);
      const detection = classifyScreen(runtime, visible, title);
      // 提交确认要标题自己作证:传空屏幕即只跑标题规则,合并判定的 working 可能来自粘贴正文
      if (title !== baselineTitle && classifyScreen(runtime, '', title).state === 'working') return;
      const enterWouldSubmit =
        detection.state !== 'pending'
        && !detection.skipStateUpdate
        && !detectStartupDialog(visible, runtime)
        && !TRUST_DIALOGS[runtime].test(visible)
        && !detectRuntimeCompletionPopup(visible, runtime);
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
    throw new Error(`runtime ack timeout (paneId=${pane.paneId})${baselineWorking ? ': baseline already matched a working rule; submit evidence unobservable on screen' : ''}`);
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
        const screenOnly = classifyScreen(runtime, stripped);
        // 标题规则优先级最高:屏幕单独判 ready 也必须带标题复核后才能返回
        const worthTitleRead = opts.titleIdleFastPath
          ? screenOnly.state === 'idle'
          : hasRuntimeReadyView(stripped, runtime, screenOnly);
        if (worthTitleRead) {
          lastTitle = await this.readPaneTitle(pane, cmdOpts);
          if (hasRuntimeReadyView(stripped, runtime, classifyScreen(runtime, stripped, lastTitle))) return;
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

function tmuxProbeOutcomeUnknown(result: Pick<ExecResult, 'exitCode' | 'stdout' | 'stderr'>): boolean {
  if (result.exitCode === 255) return true;
  const stderrSansSocketAbsence = (result.stderr || '').replace(
    /error connecting to \S+ \(no such file or directory\)/gi,
    '',
  );
  return isTransientNetworkFailure(stderrSansSocketAbsence) || isTransientNetworkFailure(result.stdout);
}

function isTargetGone(stderr: string): boolean {
  const s = (stderr || '').trim().toLowerCase();
  return /can'?t find (?:pane|window)/.test(s) || s.includes('no such pane') || s.includes('no such window');
}
