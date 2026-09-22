import { vi, type Mock } from 'vitest';
import type {
  CommandRunner,
  ExecOptions,
  ExecResult,
} from '../../src/agent/runner.js';
import type { AgentRuntimeKind } from '../../src/agent/tmux.js';
import { classifyScreen } from '../../src/agent/detect/classify.js';

export type ProtocolOutcome = 'ok' | 'ok-255' | 'applied-lost' | 'not-applied-lost' | 'refused';

export interface ProtocolTweak {
  outcome?: ProtocolOutcome;
  titleOnSubmit?: 'unchanged';
  titleHold?: 'sticky';
  // 补全弹窗/vim Normal 模式吃掉回车:按键送达了 tmux,行编辑器不当它是提交
  enter?: 'swallowed';
}

type RunnerReply =
  | Partial<ExecResult>
  | ProtocolTweak
  | ((command: string, options?: ExecOptions) => Partial<ExecResult> | ProtocolTweak | Promise<Partial<ExecResult> | ProtocolTweak>);

export interface FakeRunnerRule {
  match: string | RegExp | ((command: string, options?: ExecOptions) => boolean);
  reply: RunnerReply;
}

export type InterruptMode = 'idle' | 'ignored-live' | 'ignored-static';

export interface FakeRunnerAgent {
  paneId?: string;
  process?: string;
  screen?: string;
  workdir?: string;
  runtime?: AgentRuntimeKind;
  title?: string;
  workingTitle?: string;
  trustDialog?: string;
  interrupt?: InterruptMode;
  sessionId?: string;
  serverPid?: string;
  serverStart?: string;
  claim?: string | null;
  nonce?: string | null;
  options?: Record<string, string>;
}

export interface FakeRunnerOptions {
  rules?: FakeRunnerRule[];
  defaultResult?: Partial<ExecResult>;
  agents?: Record<string, FakeRunnerAgent>;
  session?: 'present' | 'absent';
  onExec?: (command: string, options?: ExecOptions) => void | Promise<void>;
  ackHoldCaptures?: number;
}

export interface PastedPrompt {
  pane: string;
  body: string;
}

export interface SeedSessionOptions {
  present?: boolean;
  nonce?: string | null;
  claim?: string | null;
  options?: Record<string, string>;
  paneId?: string;
  process?: string;
  runtime?: AgentRuntimeKind;
}

export interface PaneView {
  id: string;
  process: string;
  phase: PanePhase;
  composer: string;
  title: string;
  frame: string;
}

export interface FakeSessions {
  drop(agentId: string): void;
  dropPane(agentId: string, paneId: string): void;
  reclaim(agentId: string, claim: string | null): void;
  bumpGeneration(agentId: string): void;
  seed(name: string, opts?: SeedSessionOptions): void;
  setInterrupt(agentId: string, mode: InterruptMode): void;
  markWorking(agentId: string, frame?: string): void;
  setProcess(agentId: string, process: string): void;
  present(agentId: string): boolean;
  pane(agentId: string, paneId?: string): PaneView | null;
  option(agentId: string, key: string): string | undefined;
}

export interface FakeRunner extends CommandRunner {
  exec: Mock<CommandRunner['exec']>;
  writeFile: Mock<CommandRunner['writeFile']>;
  execWithStdin: Mock<CommandRunner['execWithStdin']>;
  sentKeys: string[];
  pastedPrompts: PastedPrompt[];
  sessions: FakeSessions;
}

const SUCCESS: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const DEFAULT_SERVER_PID = '4242';
const DEFAULT_SERVER_START = '1700000000';
const CREATION_NONCE_ENV = 'BAXIAN_CREATION_NONCE';
const SHELL_PROCESS = 'zsh';
const SHELL_TITLE = 'zsh';
const SHELL_PROMPT = '$ ';

type PanePhase = 'shell' | 'dialog' | 'idle' | 'working' | 'other';

interface RuntimeProfile {
  process: string;
  idleFrame: (workdir: string) => string;
  workingFrame: string;
  idleTitle: string;
  workingTitle: string | null;
  exitCommand: string;
  dialogFrame: string | null;
  dialogAccepted: string | null;
  acceptCursor: RegExp | null;
  ctrlCQuitsEmptyComposer: boolean;
  // 回车要被当成提交而不是被吞掉,最少得与正文隔开多远(实测 claude-code 2.1.278 / codex 0.155.1 / opencode 1.18.31 / qodercli 1.1.10):
  // 键入的字符对 codex 要等到草稿被读出来(突发窗口比一次 exec 往返还长),对 opencode 要另起一条命令;括号粘贴自带结束标记,codex 同一条命令即可
  enterAfterTyping: 'same-command' | 'next-command' | 'observed-draft';
  enterAfterPaste: 'same-command' | 'next-command';
}

export const RUNTIME_PROFILES: Record<AgentRuntimeKind, RuntimeProfile> = {
  'claude-code': {
    process: 'claude',
    idleFrame: workdir => `⏵⏵ bypass permissions on ${workdir}\n\n> `,
    workingFrame: '✻ Thinking… (3s · esc to interrupt)\n',
    idleTitle: '✳ Claude Code',
    workingTitle: '⠂ Claude Code',
    exitCommand: '/exit',
    dialogFrame: 'Quick safety check\nDo you trust this folder?\n  1. Yes, I trust this folder\n› 2. No, exit\n',
    dialogAccepted: 'Quick safety check\nDo you trust this folder?\n› 1. Yes, I trust this folder\n  2. No, exit\n',
    acceptCursor: /^[ \t]*[❯›>][ \t]*(?:\d+\.[ \t]*)?Yes, I trust this folder/m,
    ctrlCQuitsEmptyComposer: false,
    enterAfterTyping: 'same-command',
    enterAfterPaste: 'same-command',
  },
  codex: {
    process: 'codex',
    idleFrame: () => 'permissions: YOLO mode\n\n› ',
    workingFrame: '• Working (3s • esc to interrupt)\n',
    idleTitle: 'codex',
    workingTitle: '⠋ codex',
    exitCommand: '/quit',
    dialogFrame: 'Do you trust the contents of this directory?\n› Yes, continue\n',
    dialogAccepted: null,
    acceptCursor: null,
    ctrlCQuitsEmptyComposer: true,
    enterAfterTyping: 'observed-draft',
    enterAfterPaste: 'same-command',
  },
  opencode: {
    process: 'opencode',
    idleFrame: () => '> \n\nctrl+p commands\n',
    workingFrame: 'Thinking… esc to interrupt\n',
    idleTitle: 'opencode',
    workingTitle: null,
    exitCommand: '/exit',
    dialogFrame: null,
    dialogAccepted: null,
    acceptCursor: null,
    ctrlCQuitsEmptyComposer: false,
    enterAfterTyping: 'next-command',
    enterAfterPaste: 'next-command',
  },
  qodercli: {
    process: 'qodercli',
    idleFrame: () => '> \n\nType your message or @path/to/file\n',
    workingFrame: '⠋ Thinking (esc to cancel, 3s)\n',
    idleTitle: 'qodercli',
    workingTitle: null,
    exitCommand: '/quit',
    dialogFrame: 'Do you trust the files in this folder?\n› Trust folder\n',
    dialogAccepted: null,
    acceptCursor: null,
    ctrlCQuitsEmptyComposer: false,
    enterAfterTyping: 'same-command',
    enterAfterPaste: 'same-command',
  },
};

const COMPOSER_WRAP_COLUMNS = 80;

const SHELL_PROCESSES = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ash', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'xonsh', 'pwsh']);

function runtimeForProcess(process: string): AgentRuntimeKind | null {
  if (process === 'claude' || process === 'claude.exe' || /^\d+\.\d+\.\d+$/.test(process)) return 'claude-code';
  if (process === 'codex' || process === 'node') return 'codex';
  if (process === 'opencode') return 'opencode';
  if (process === 'qodercli' || process.startsWith('qodercli-')) return 'qodercli';
  return null;
}

// 只有命令真正 exec 到 runtime 可执行文件才算启动:`echo claude` / `command -v codex` 这类只是把名字当参数。
// cd 的目录按 shell 引用规则分词(shellQuote 会把路径里的单引号编成 '\''),否则合法的带引号 workdir 会被整条拒绝
function runtimeForLaunch(line: string): { runtime: AgentRuntimeKind; workdir?: string } | null {
  let words = shellWords(line);
  let workdir: string | undefined;
  if (words[0] === 'cd') {
    const sep = words.indexOf('&&');
    if (sep === -1) return null;
    const dirWords = words.slice(1, sep);
    // 未加引号的多词目录在真实 shell 里是 `cd: too many arguments`,&& 右边根本不会执行
    if (dirWords.length > 1) return null;
    workdir = dirWords[0];
    words = words.slice(sep + 1);
  }
  if (words[0] === 'env') {
    let i = 1;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    words = words.slice(i);
  }
  const exe = words[0];
  if (exe === undefined) return null;
  const runtime = exe === 'claude' ? 'claude-code'
    : exe === 'codex' || exe === 'opencode' || exe === 'qodercli' ? exe
    : null;
  if (runtime === null) return null;
  return workdir === undefined ? { runtime } : { runtime, workdir };
}

interface PaneModel {
  id: string;
  process: string;
  runtime: AgentRuntimeKind;
  phase: PanePhase;
  customIdleFrame: string | null;
  customFrame: string | null;
  composer: string;
  title: string;
  options: Map<string, string>;
  dialogFrame: string | null;
  dialogSelectedYes: boolean;
  workingCaptures: number;
  liveTick: number;
  lastSubmitted: string;
  titleSticky: boolean;
  interrupt: InterruptMode;
  workingTitleOverride: string | null;
  idleTitle: string;
}

interface SessionModel {
  name: string;
  present: boolean;
  sessionId: string;
  serverPid: string;
  serverStart: string;
  claim: string | null;
  nonce: string | null;
  workdir: string;
  runtime: AgentRuntimeKind;
  options: Map<string, string>;
  panes: Map<string, PaneModel>;
}

interface EvalContext {
  session?: SessionModel;
  pane?: PaneModel;
}

// shell 风格分词:单引号原样、'\'' 转义、双引号保留内容,空白分隔
export function shellWords(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let quoted = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "'") {
      let j = i + 1;
      while (j < input.length && input[j] !== "'") current += input[j++];
      i = j + 1;
      quoted = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) j++;
        current += input[j++];
      }
      i = j + 1;
      quoted = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1];
      i += 2;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== '' || quoted) words.push(current);
      current = '';
      quoted = false;
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current !== '' || quoted) words.push(current);
  return words;
}

// tmux 的子命令用 ' ; ' 分隔,但引号内的分号是载荷的一部分(提示词、启动参数都可能带)
export function splitTmuxCommands(list: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < list.length) current += list[++i];
      continue;
    }
    // 引号外的 \' 是字面量引号(tmux 参数里的 '\'' 转义),不能当成开/闭引号
    if (ch === '\\' && i + 1 < list.length) { current += ch + list[++i]; continue; }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ';' && /\s$/.test(current) && (i + 1 >= list.length || /\s/.test(list[i + 1]!))) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function matchingBrace(format: string, open: number): number {
  let depth = 0;
  for (let i = open; i < format.length; i++) {
    if (format[i] === '{') depth++;
    else if (format[i] === '}' && --depth === 0) return i;
  }
  throw new Error(`unbalanced tmux format: ${format}`);
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') depth--;
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

const truthy = (value: string): boolean => value !== '' && value !== '0';

function fnmatchToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if (ch === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        source += '\\[';
      } else {
        const cls = glob.slice(i + 1, end);
        source += `[${cls.startsWith('!') ? `^${cls.slice(1)}` : cls}]`;
        i = end;
      }
    } else source += ch!.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

type FieldResolver = (field: string) => string | undefined;

// display-message 把整串先交给 strftime 再展开 #{},嵌套操作数被递归展开时会再跑一次:%N 形态的 pane id
// 字面量就是这样被当成转换符吃掉的。这里只近似"未知转换符连同 % 一起消失",%% 仍收敛成一个 %
const strftime = (format: string): string => format.replace(/%(.?)/g, (_, ch: string) => (ch === '%' ? '%' : ''));

function evalFormat(format: string, resolve: FieldResolver, time = false): string {
  const fmt = time ? strftime(format) : format;
  let out = '';
  for (let i = 0; i < fmt.length;) {
    if (fmt.startsWith('#{', i)) {
      const end = matchingBrace(fmt, i + 1);
      out += evalExpr(fmt.slice(i + 2, end), resolve, time);
      i = end + 1;
    } else {
      out += fmt[i++];
    }
  }
  return out;
}

function evalExpr(body: string, resolve: FieldResolver, time: boolean): string {
  const evaluate = (part: string): string => evalFormat(part, resolve, time);
  if (body.startsWith('?')) {
    const [cond = '', yes = '', no = ''] = splitTopLevel(body.slice(1));
    return truthy(evaluate(cond)) ? evaluate(yes) : evaluate(no);
  }
  const colon = body.indexOf(':');
  if (colon === -1) {
    const value = resolve(body);
    return value === undefined ? `<${body}>` : value;
  }
  const op = body.slice(0, colon);
  const args = splitTopLevel(body.slice(colon + 1)).map(evaluate);
  switch (op) {
    case '==': return args[0] === args[1] ? '1' : '0';
    case '!=': return args[0] !== args[1] ? '1' : '0';
    case '&&': return args.every(truthy) ? '1' : '0';
    case '||': return args.some(truthy) ? '1' : '0';
    case 'm': return fnmatchToRegExp(args[0]!).test(args[1]!) ? '1' : '0';
    case 'e|<=': return Number(args[0]) <= Number(args[1]) ? '1' : '0';
    case 'e|<': return Number(args[0]) < Number(args[1]) ? '1' : '0';
    case 'e|>=': return Number(args[0]) >= Number(args[1]) ? '1' : '0';
    case 'e|>': return Number(args[0]) > Number(args[1]) ? '1' : '0';
    case 'e|==': return Number(args[0]) === Number(args[1]) ? '1' : '0';
    default: throw new Error(`unsupported tmux format modifier ${op}`);
  }
}

// 遗留的宽松判定(tmux.test 直接调用):pane 身份一律视为成立,只求值前台条件
export function foregroundCondAccepts(command: string, process: string): boolean {
  const cond = /-F '([^']*)'/.exec(command)?.[1];
  if (cond === undefined) return true;
  const lenient: FieldResolver = field => (field === 'pane_current_command' ? process : undefined);
  const wrapped = (format: string): string => evalFormat(format, lenient);
  const patched = cond.replace(/#\{==:#\{(pid|start_time|session_id|pane_id|@baxian-agent-id)\},[^}]*\}/g, '1');
  return wrapped(patched) === '1';
}

function matches(
  matcher: FakeRunnerRule['match'],
  command: string,
  options?: ExecOptions,
): boolean {
  if (typeof matcher === 'string') return command.includes(matcher);
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(command);
  }
  return matcher(command, options);
}

function isTweak(reply: Partial<ExecResult> | ProtocolTweak): reply is ProtocolTweak {
  return 'outcome' in reply || 'titleOnSubmit' in reply || 'titleHold' in reply || 'enter' in reply;
}

function complete(result: Partial<ExecResult>): ExecResult {
  return { ...SUCCESS, ...result };
}

function sessionAbsent(target: string): ExecResult {
  return complete({ stderr: `can't find session: ${target}`, exitCode: 1 });
}

function paneAbsent(paneId: string): ExecResult {
  return complete({ stderr: `can't find pane: ${paneId}`, exitCode: 1 });
}

class TmuxModel {
  readonly sessions = new Map<string, SessionModel>();
  readonly staged = new Map<string, string>();
  readonly pastedPrompts: PastedPrompt[] = [];
  // 同一 server 上 session id 与 pane id 都必须全局唯一:显式指定、自动分配、new-session 共用登记表
  private readonly usedSessionIds = new Set<string>();
  private readonly usedPaneIds = new Set<string>();
  private readonly draftTyped = new Map<string, { command: number; observed: boolean; pasted: boolean }>();
  private command = 0;

  constructor(
    agents: Record<string, FakeRunnerAgent>,
    presentByDefault: boolean,
    private readonly ackHoldCaptures: number,
  ) {
    // dev-1 / qa-1 先建,拿到稳定的 $1 / $2;同一 server 上 id 必须唯一,否则守卫会退化成"按 claim 找目标"
    const ids = new Set(['dev-1', 'qa-1', ...Object.keys(agents)]);
    for (const id of ids) this.sessions.set(id, this.buildSession(id, agents[id] ?? {}, presentByDefault));
  }

  // 显式 id 直接登记(撞号是用例配置错误,真实 tmux 不可能出现,必须炸出来);未指定则取下一个空闲编号
  private claimSessionId(explicit?: string): string {
    if (explicit !== undefined) {
      if (this.usedSessionIds.has(explicit)) {
        throw new Error(`fakeRunner: session id ${explicit} already taken; ids must be unique on one tmux server`);
      }
      this.usedSessionIds.add(explicit);
      return explicit;
    }
    for (let n = 1; ; n++) {
      const id = `$${n}`;
      if (this.usedSessionIds.has(id)) continue;
      this.usedSessionIds.add(id);
      return id;
    }
  }

  private releaseSessionId(id: string): void {
    this.usedSessionIds.delete(id);
  }

  // pane id 与 session id 同理:dev-1 %0、qa-1 %1,第三个 agent 不能再拿到 %0,否则 paneOwner 会解析到别人
  private claimPaneId(explicit?: string): string {
    if (explicit !== undefined) {
      if (this.usedPaneIds.has(explicit)) {
        throw new Error(`fakeRunner: pane id ${explicit} already taken; ids must be unique on one tmux server`);
      }
      this.usedPaneIds.add(explicit);
      return explicit;
    }
    for (let n = 0; ; n++) {
      const id = `%${n}`;
      if (this.usedPaneIds.has(id)) continue;
      this.usedPaneIds.add(id);
      return id;
    }
  }

  private releasePaneIds(session: SessionModel): void {
    for (const paneId of session.panes.keys()) this.usedPaneIds.delete(paneId);
  }

  private buildSession(id: string, spec: FakeRunnerAgent, present: boolean): SessionModel {
    const isQa = id === 'qa-1';
    const runtime = spec.runtime
      ?? (spec.process ? runtimeForProcess(spec.process) : null)
      ?? (isQa ? 'codex' : 'claude-code');
    const workdir = spec.workdir ?? (isQa ? '/tmp/qa-repo' : '/tmp/repo');
    const session: SessionModel = {
      name: id,
      present,
      sessionId: this.claimSessionId(spec.sessionId),
      serverPid: spec.serverPid ?? DEFAULT_SERVER_PID,
      serverStart: spec.serverStart ?? DEFAULT_SERVER_START,
      claim: spec.claim === undefined ? id : spec.claim,
      nonce: spec.nonce ?? null,
      workdir,
      runtime,
      options: new Map(Object.entries(spec.options ?? {})),
      panes: new Map(),
    };
    const paneId = this.claimPaneId(spec.paneId);
    session.panes.set(paneId, this.buildPane(paneId, spec, session));
    return session;
  }

  private buildPane(paneId: string, spec: FakeRunnerAgent, session: SessionModel): PaneModel {
    const profile = RUNTIME_PROFILES[session.runtime];
    const process = spec.process ?? profile.process;
    const pane: PaneModel = {
      id: paneId,
      process,
      runtime: session.runtime,
      phase: 'idle',
      customIdleFrame: null,
      customFrame: null,
      composer: '',
      title: spec.title ?? profile.idleTitle,
      options: new Map(),
      dialogFrame: spec.trustDialog ?? null,
      dialogSelectedYes: true,
      workingCaptures: 0,
      liveTick: 0,
      lastSubmitted: '',
      titleSticky: false,
      interrupt: spec.interrupt ?? 'idle',
      workingTitleOverride: spec.workingTitle ?? null,
      idleTitle: spec.title ?? profile.idleTitle,
    };
    if (SHELL_PROCESSES.has(process)) {
      pane.phase = 'shell';
      pane.title = SHELL_TITLE;
      if (spec.screen !== undefined) pane.customFrame = spec.screen;
      return pane;
    }
    if (runtimeForProcess(process) === null) {
      pane.phase = 'other';
      pane.customFrame = spec.screen ?? '';
      pane.title = process;
      return pane;
    }
    if (spec.screen !== undefined) {
      const state = classifyScreen(session.runtime, spec.screen).state;
      if (state === 'working') {
        pane.phase = 'working';
        pane.customFrame = spec.screen;
        pane.workingCaptures = Number.NEGATIVE_INFINITY;
      } else if (profile.dialogFrame && isDialogFrame(session.runtime, spec.screen)) {
        pane.phase = 'dialog';
        pane.dialogFrame = spec.screen;
        pane.dialogSelectedYes = profile.acceptCursor ? profile.acceptCursor.test(spec.screen) : true;
      } else {
        pane.customIdleFrame = spec.screen;
      }
    }
    return pane;
  }

  private workingTitleOf(pane: PaneModel): string | null {
    return pane.workingTitleOverride ?? RUNTIME_PROFILES[pane.runtime].workingTitle;
  }

  sessionByName(name: string): SessionModel | undefined {
    return this.sessions.get(name);
  }

  presentSessions(): SessionModel[] {
    return [...this.sessions.values()].filter(s => s.present);
  }

  paneOwner(paneId: string): { session: SessionModel; pane: PaneModel } | null {
    for (const session of this.presentSessions()) {
      const pane = session.panes.get(paneId);
      if (pane) return { session, pane };
    }
    return null;
  }

  // pane 找不到时区分两种 stderr:所属会话已消失 → can't find session(生产侧 PaneGoneError);会话仍在但 pane 已删 → can't find pane
  dropPane(agentId: string, paneId: string): void {
    if (this.sessionByName(agentId)?.panes.delete(paneId)) this.usedPaneIds.delete(paneId);
  }

  paneMissing(paneId: string): ExecResult {
    for (const session of this.sessions.values()) {
      if (!session.present && session.panes.has(paneId)) return sessionAbsent(session.name);
    }
    return paneAbsent(paneId);
  }

  // -t 目标:%N → pane、$N → session id、=name: / =name → session name
  resolveTarget(target: string | undefined): { candidates: EvalContext[]; missing?: ExecResult } {
    if (target === undefined) {
      const first = this.presentSessions()[0];
      return { candidates: first ? [{ session: first, pane: first.panes.values().next().value }] : [{}] };
    }
    if (target.startsWith('%')) {
      const owner = this.paneOwner(target);
      if (owner) return { candidates: [owner] };
      return { candidates: [{}], missing: this.paneMissing(target) };
    }
    const name = target.replace(/^=/, '').replace(/:$/, '');
    const byName = this.sessionByName(name);
    if (target.startsWith('=')) {
      if (!byName?.present) return { candidates: [{}], missing: sessionAbsent(name) };
      return { candidates: [{ session: byName, pane: byName.panes.values().next().value }] };
    }
    // 同一 server 上 session id 唯一:目标只由 ref 定位,claim 不参与选目标(否则守卫会反过来把写操作挪到别的会话)
    // id 在登记表里唯一,目标因此只有一个:守卫无从在候选间"重新选目标"
    const byId = this.presentSessions().find(s => s.sessionId === target);
    if (!byId) return { candidates: [{}], missing: sessionAbsent(target) };
    return { candidates: [{ session: byId, pane: byId.panes.values().next().value }] };
  }

  resolver(ctx: EvalContext): FieldResolver {
    const { session, pane } = ctx;
    return field => {
      switch (field) {
        case 'pid': return session?.serverPid ?? DEFAULT_SERVER_PID;
        case 'start_time': return session?.serverStart ?? DEFAULT_SERVER_START;
        case 'session_id': return session?.sessionId ?? '';
        case 'session_name': return session?.name ?? '';
        case 'pane_id': return pane?.id ?? '';
        case 'pane_current_command': return pane?.process ?? '';
        case 'pane_current_path': return session?.workdir ?? '';
        case 'pane_title': return pane?.title ?? '';
        case 'pane_width': return String(COMPOSER_WRAP_COLUMNS);
        case 'pane_height': return '40';
        // composer 从第 2 列起排,窄窗格会折行:列回到原值而行推进,正是 submitToRuntime 要认的那种证据
        case 'cursor_x': return String((2 + (pane?.composer.length ?? 0)) % COMPOSER_WRAP_COLUMNS);
        case 'cursor_y': return String(10 + Math.floor((2 + (pane?.composer.length ?? 0)) / COMPOSER_WRAP_COLUMNS));
        case 'history_size': return '0';
        case 'window_width': return '200';
        case 'window_height': return '50';
        case 'status': return 'off';
        case 'window-size': return session?.options.get('window-size') ?? 'latest';
        case 'version': return '3.4';
        default:
          if (field.startsWith('@')) {
            return pane?.options.get(field) ?? session?.options.get(field) ?? (field === '@baxian-agent-id' ? (session?.claim ?? '') : '');
          }
          return '';
      }
    };
  }

  evaluate(format: string, ctx: EvalContext): string {
    return evalFormat(format, this.resolver(ctx));
  }

  evaluateMessage(format: string, ctx: EvalContext): string {
    return evalFormat(format, this.resolver(ctx), true);
  }

  render(pane: PaneModel, session: SessionModel, peek = false): string {
    const profile = RUNTIME_PROFILES[pane.runtime];
    switch (pane.phase) {
      case 'shell':
        return pane.customFrame ?? `${SHELL_PROMPT}${pane.composer}`;
      case 'other':
        return pane.customFrame ?? '';
      case 'dialog': {
        const base = pane.dialogFrame ?? profile.dialogFrame ?? '';
        if (pane.dialogSelectedYes && profile.acceptCursor && !profile.acceptCursor.test(base)) {
          return profile.dialogAccepted ?? base;
        }
        return base;
      }
      case 'working': {
        if (!peek) {
          pane.workingCaptures += 1;
          if (pane.interrupt === 'ignored-live') pane.liveTick += 1;
        }
        const frame = pane.customFrame ?? profile.workingFrame;
        if (pane.interrupt === 'ignored-live') return `${frame}⠋ tick ${pane.liveTick}\n`;
        if (!peek && pane.interrupt === 'idle' && pane.workingCaptures >= this.ackHoldCaptures) {
          this.settleIdle(pane);
          return this.render(pane, session);
        }
        return frame;
      }
      case 'idle':
      default:
        return `${pane.customIdleFrame ?? profile.idleFrame(session.workdir)}${pane.composer}`;
    }
  }

  // explicit=true 表示 Escape 中断或 C-c 清稿这类显式转换:它们必须把标题一起收干净,sticky 只用于自动回落的故障注入
  private settleIdle(pane: PaneModel, explicit = false): void {
    pane.phase = 'idle';
    pane.customFrame = null;
    pane.workingCaptures = 0;
    pane.liveTick = 0;
    if (explicit) pane.titleSticky = false;
    if (!pane.titleSticky) pane.title = pane.idleTitle;
  }

  private becomeShell(pane: PaneModel): void {
    pane.phase = 'shell';
    pane.process = SHELL_PROCESS;
    pane.customFrame = null;
    pane.customIdleFrame = null;
    pane.composer = '';
    pane.title = SHELL_TITLE;
    pane.workingCaptures = 0;
  }

  private launchRuntime(pane: PaneModel, session: SessionModel, runtime: AgentRuntimeKind): void {
    const profile = RUNTIME_PROFILES[runtime];
    pane.runtime = runtime;
    session.runtime = runtime;
    pane.process = profile.process;
    pane.composer = '';
    pane.customFrame = null;
    pane.workingCaptures = 0;
    const dialog = pane.dialogFrame ?? null;
    pane.idleTitle = profile.idleTitle;
    pane.title = profile.idleTitle;
    if (dialog) {
      pane.phase = 'dialog';
      pane.dialogSelectedYes = profile.acceptCursor ? profile.acceptCursor.test(dialog) : true;
      return;
    }
    pane.phase = 'idle';
  }

  // inner 命令(if-shell 分支内或顶层)逐条执行;返回 null 表示继续,返回结果表示中止
  runInner(inner: string, ctx: EvalContext, out: string[], tweak: ProtocolTweak): ExecResult | null {
    const words = shellWords(inner);
    const sub = words[0];
    const { session, pane } = ctx;
    const arg = (flag: string): string | undefined => {
      const i = words.indexOf(flag);
      return i === -1 ? undefined : words[i + 1];
    };
    const scopeFor = (target: string | undefined): { candidates: EvalContext[]; missing?: ExecResult } => {
      if (target === undefined) return { candidates: [ctx] };
      if (session && (target === session.sessionId || target.replace(/^=/, '').replace(/:$/, '') === session.name)) {
        return { candidates: [ctx] };
      }
      return this.resolveTarget(target);
    };
    switch (sub) {
      case 'display-message': {
        const fmt = words[words.length - 1] ?? '';
        const local = scopeFor(arg('-t'));
        if (local.missing) return local.missing;
        const ctx = local.candidates[0]!;
        if (ctx.pane) this.observeDraft(ctx.pane.id);
        out.push(this.evaluateMessage(fmt, ctx));
        return null;
      }
      case 'capture-pane': {
        const target = arg('-t');
        const owner = target ? this.paneOwner(target) : (pane && session ? { session, pane } : null);
        if (!owner) return target ? this.paneMissing(target) : sessionAbsent('');
        this.observeDraft(owner.pane.id);
        out.push(this.render(owner.pane, owner.session));
        return null;
      }
      case 'send-keys': {
        // getopt 语义:选项到第一个非选项参数(或 --)为止,之后的 -l 是正文而不是选项
        const valueFlags = new Set(['-t', '-N', '-c']);
        const knownFlags = new Set(['-l', '-F', '-H', '-K', '-M', '-R', '-X', ...valueFlags]);
        let cursor = 1;
        let literal = false;
        let target: string | undefined;
        for (; cursor < words.length; cursor++) {
          const word = words[cursor]!;
          if (word === '--') { cursor++; break; }
          if (!word.startsWith('-') || word === '-') break;
          if (!knownFlags.has(word)) return complete({ stderr: `command send-keys: unknown flag ${word}`, exitCode: 1 });
          if (valueFlags.has(word)) {
            const value = words[cursor + 1];
            if (value === undefined) return complete({ stderr: `command send-keys: ${word} expects an argument`, exitCode: 1 });
            if (word === '-t') target = value;
            cursor++;
          } else if (word === '-l') literal = true;
        }
        const owner = target ? this.paneOwner(target) : (pane && session ? { session, pane } : null);
        if (!owner) return target ? this.paneMissing(target) : sessionAbsent('');
        this.sendKeys(owner.pane, owner.session, literal, words.slice(cursor), tweak);
        return null;
      }
      case 'paste-buffer': {
        const buf = arg('-b') ?? '';
        const target = arg('-t');
        const owner = target ? this.paneOwner(target) : null;
        if (!owner) return target ? this.paneMissing(target) : sessionAbsent('');
        const body = this.staged.get(buf);
        if (body === undefined) return complete({ stderr: `no buffer ${buf}`, exitCode: 1 });
        if (words.includes('-d')) this.staged.delete(buf);
        // 真实 paste-buffer 只在光标处插入,不清稿:遗漏 clear 或重复 paste 必须表现为脏稿
        owner.pane.composer += body;
        this.draftTyped.set(owner.pane.id, { command: this.command, observed: false, pasted: true });
        this.pastedPrompts.push({ pane: owner.pane.id, body });
        return null;
      }
      case 'delete-buffer': {
        const buf = arg('-b') ?? '';
        if (!this.staged.has(buf)) return complete({ stderr: `unknown buffer: ${buf}`, exitCode: 1 });
        this.staged.delete(buf);
        return null;
      }
      case 'set-option': {
        if (words.includes('-s') || words.includes('-sa')) return null;
        const target = arg('-t');
        const key = words[words.length - 2] ?? '';
        const value = words[words.length - 1] ?? '';
        const scope = scopeFor(target);
        if (scope.missing) return scope.missing;
        const local = scope.candidates[0]!;
        if (target?.startsWith('%') && local.pane) local.pane.options.set(key, value);
        else if (local.session) {
          if (key === '@baxian-agent-id') local.session.claim = value === '' ? null : value;
          local.session.options.set(key, value);
        }
        return null;
      }
      case 'kill-session': {
        const scope = scopeFor(arg('-t'));
        if (scope.missing) return scope.missing;
        const victim = scope.candidates[0]!.session;
        if (victim) victim.present = false;
        return null;
      }
      case 'resize-window':
      case 'select-pane':
      case 'refresh-client':
        return null;
      default:
        return null;
    }
  }

  // 一条 tmux 命令列表 = 一批输入;跨命令的读则要求客户端真的往返过一次,runtime 因此已经处理并渲染了草稿
  beginCommand(): void {
    this.command++;
  }

  observeDraft(paneId: string): void {
    const typed = this.draftTyped.get(paneId);
    if (typed && typed.command < this.command) typed.observed = true;
  }

  private sendKeys(pane: PaneModel, session: SessionModel, literal: boolean, keys: string[], tweak: ProtocolTweak): void {
    const profile = RUNTIME_PROFILES[pane.runtime];
    if (literal) {
      if (pane.phase === 'dialog' || pane.phase === 'other') return;
      pane.composer += keys.join('');
      this.draftTyped.set(pane.id, { command: this.command, observed: false, pasted: false });
      return;
    }
    for (const key of keys) {
      switch (key) {
        case 'Enter':
          this.enter(pane, session, tweak);
          break;
        // 实测 codex 0.155.1 / claude-code 2.1.278 / qodercli 1.1.10 / opencode 1.18.31:C-u 删到行首,空 composer 上是空操作
        case 'C-u':
          if (pane.phase === 'shell' || pane.phase === 'other' || pane.phase === 'dialog') break;
          pane.composer = '';
          this.draftTyped.delete(pane.id);
          break;
        case 'C-c':
          if (pane.phase === 'shell') { pane.composer = ''; break; }
          if (pane.phase === 'other' || pane.phase === 'dialog') break;
          if (profile.ctrlCQuitsEmptyComposer && pane.composer === '' && pane.phase !== 'working') {
            this.becomeShell(pane);
            break;
          }
          pane.composer = '';
          this.draftTyped.delete(pane.id);
          this.settleIdle(pane, true);
          break;
        case 'Escape':
          if (pane.phase !== 'working') break;
          if (pane.interrupt === 'idle') {
            this.settleIdle(pane, true);
            if (pane.runtime === 'claude-code') pane.composer = pane.lastSubmitted;
          }
          break;
        case 'Down':
          if (pane.phase === 'dialog') pane.dialogSelectedYes = true;
          break;
        default:
          break;
      }
    }
  }

  private enterTooSoon(pane: PaneModel, profile: RuntimeProfile): boolean {
    const draft = this.draftTyped.get(pane.id);
    if (!draft) return false;
    const needs = draft.pasted ? profile.enterAfterPaste : profile.enterAfterTyping;
    if (needs === 'next-command') return draft.command === this.command;
    return needs === 'observed-draft' && !draft.observed;
  }

  private enter(pane: PaneModel, session: SessionModel, tweak: ProtocolTweak): void {
    if (tweak.enter === 'swallowed') return;
    const profile = RUNTIME_PROFILES[pane.runtime];
    if (pane.phase === 'dialog') {
      if (pane.dialogSelectedYes) {
        pane.phase = 'idle';
        pane.customFrame = null;
        pane.title = pane.idleTitle;
      }
      return;
    }
    if (pane.phase === 'shell') {
      const line = pane.composer;
      pane.composer = '';
      const launch = runtimeForLaunch(line);
      // cd 真的执行了:pane 当前目录随之改变,ensureSession 的复用/重启判定就看这个
      if (launch) {
        if (launch.workdir !== undefined) session.workdir = launch.workdir;
        this.launchRuntime(pane, session, launch.runtime);
      }
      return;
    }
    if (pane.phase === 'other') return;
    // 回车来得太早就不是提交:草稿原样留着(真 codex 还会多一个换行,差别不影响"没提交"这个结论)
    if (this.enterTooSoon(pane, profile)) return;
    if (pane.composer === '') return;
    const submitted = pane.composer;
    pane.composer = '';
    this.draftTyped.delete(pane.id);
    if (submitted.trim() === profile.exitCommand) {
      this.becomeShell(pane);
      return;
    }
    pane.lastSubmitted = submitted;
    pane.phase = 'working';
    pane.customFrame = null;
    pane.workingCaptures = 0;
    pane.liveTick = 0;
    pane.titleSticky = tweak.titleHold === 'sticky';
    const workingTitle = this.workingTitleOf(pane);
    if (workingTitle !== null && tweak.titleOnSubmit !== 'unchanged') pane.title = workingTitle;
  }

  createSession(name: string, nonce: string | null, workdir: string | undefined, runtime: AgentRuntimeKind | undefined): { ref: string } {
    const existing = this.sessions.get(name);
    const sessionId = this.claimSessionId();
    const paneId = this.claimPaneId();
    const session: SessionModel = {
      name,
      present: true,
      sessionId,
      serverPid: existing?.serverPid ?? DEFAULT_SERVER_PID,
      serverStart: existing?.serverStart ?? DEFAULT_SERVER_START,
      claim: null,
      nonce,
      workdir: workdir ?? existing?.workdir ?? '/tmp/repo',
      runtime: runtime ?? existing?.runtime ?? 'claude-code',
      options: new Map(),
      panes: new Map(),
    };
    const pane = this.buildPane(paneId, { process: SHELL_PROCESS, interrupt: existing?.panes.values().next().value?.interrupt }, session);
    const seededDialog = existing?.panes.values().next().value?.dialogFrame ?? null;
    pane.dialogFrame = seededDialog;
    session.panes.set(paneId, pane);
    this.sessions.set(name, session);
    return { ref: `${session.serverPid}|${session.serverStart}|${sessionId}` };
  }

  seed(name: string, opts: SeedSessionOptions): void {
    const existing = this.sessions.get(name);
    // 先让出旧 id 供本次复用,但 buildSession 可能因显式撞号抛错:那时旧 session 还留在模型里,
    // pane 登记必须回滚,否则后续合法创建会再分到同一个 pane id
    const releasedPaneIds = existing ? [...existing.panes.keys()] : [];
    if (existing) {
      this.releaseSessionId(existing.sessionId);
      this.releasePaneIds(existing);
    }
    const spec: FakeRunnerAgent = {
      claim: opts.claim === undefined ? (existing?.claim ?? null) : opts.claim,
      nonce: opts.nonce === undefined ? (existing?.nonce ?? null) : opts.nonce,
      options: opts.options,
      paneId: opts.paneId ?? existing?.panes.keys().next().value,
      process: opts.process,
      runtime: opts.runtime ?? existing?.runtime,
      workdir: existing?.workdir,
      sessionId: existing?.sessionId,
    };
    let session: SessionModel;
    try {
      session = this.buildSession(name, spec, opts.present ?? true);
    } catch (err) {
      for (const paneId of releasedPaneIds) this.usedPaneIds.add(paneId);
      throw err;
    }
    if (existing && !opts.options) session.options = existing.options;
    this.sessions.set(name, session);
  }
}

function isDialogFrame(runtime: AgentRuntimeKind, frame: string): boolean {
  const patterns: Record<AgentRuntimeKind, RegExp | null> = {
    'claude-code': /Quick safety check[\s\S]{0,500}Yes, I trust this folder/,
    codex: /Do you trust the contents[\s\S]{0,500}Yes, continue/,
    opencode: null,
    qodercli: /Do you trust the files in this folder[\s\S]{0,500}Trust folder/,
  };
  return patterns[runtime]?.test(frame) ?? false;
}

function applyOutcome(result: ExecResult, tweak: ProtocolTweak): ExecResult {
  switch (tweak.outcome) {
    case 'ok-255': return { ...result, exitCode: 255 };
    case 'applied-lost': return { stdout: '', stderr: 'ssh: connection reset', exitCode: 255 };
    case 'not-applied-lost': return { stdout: '', stderr: 'ssh: connection reset', exitCode: 255 };
    default: return result;
  }
}

const COMPOUND_LOAD = /^\[ "\$\(tmux display-message -p -t '([^']+)' '([^']+)'\)" = '((?:[^']|'\\'')*)' \] && tmux load-buffer -b '([^']+)' -$/;

export function fakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const sentKeys: string[] = [];
  const model = new TmuxModel(options.agents ?? {}, options.session !== 'absent', options.ackHoldCaptures ?? 3);

  const resolveRule = async (command: string, execOptions?: ExecOptions): Promise<Partial<ExecResult> | ProtocolTweak | null> => {
    const rule = options.rules?.find(candidate => matches(candidate.match, command, execOptions));
    if (!rule) return null;
    return typeof rule.reply === 'function' ? rule.reply(command, execOptions) : rule.reply;
  };

  const protocol = (command: string, tweak: ProtocolTweak): ExecResult => {
    model.beginCommand();
    const trimmed = command.trim();
    const cdMatch = /^cd (?:-P )?'((?:[^']|'\\'')*)'(?: 2>\/dev\/null)? && pwd -P$/.exec(trimmed);
    if (cdMatch) return complete({ stdout: `${cdMatch[1]!.replace(/'\\''/g, "'")}\n` });
    if (!trimmed.startsWith('tmux ')) {
      if (trimmed.startsWith('(tmux show-option')) return SUCCESS;
      return SUCCESS;
    }
    const words = shellWords(trimmed.slice(5));
    const sub = words[0];
    const arg = (flag: string): string | undefined => {
      const i = words.indexOf(flag);
      return i === -1 ? undefined : words[i + 1];
    };
    switch (sub) {
      case 'new-session': {
        const name = arg('-s') ?? '';
        const envs = words.map((w, i) => (w === '-e' ? words[i + 1] : null)).filter((w): w is string => w !== null);
        const nonce = envs.find(e => e.startsWith(`${CREATION_NONCE_ENV}=`))?.slice(CREATION_NONCE_ENV.length + 1) ?? null;
        const existing = model.sessionByName(name);
        // 回复丢失时调用方只知道结果未知:已存在的会话不会被再次创建,新建的会话照常留在服务端
        if (tweak.outcome === 'not-applied-lost' || (tweak.outcome === 'applied-lost' && existing?.present)) {
          return applyOutcome(SUCCESS, { outcome: 'not-applied-lost' });
        }
        if (existing?.present) return complete({ stderr: `duplicate session: ${name}`, exitCode: 1 });
        const { ref } = model.createSession(name, nonce, arg('-c'), undefined);
        return applyOutcome(complete({ stdout: `${ref}\n` }), tweak);
      }
      case 'list-sessions': {
        const fmt = arg('-F') ?? '';
        const filter = arg('-f');
        const lines = model.presentSessions()
          .filter(s => !filter || truthy(model.evaluate(filter, { session: s, pane: s.panes.values().next().value })))
          .map(s => model.evaluate(fmt, { session: s, pane: s.panes.values().next().value }));
        if (model.presentSessions().length === 0) return complete({ stderr: 'no server running on /tmp/tmux-501/default', exitCode: 1 });
        return complete({ stdout: lines.length ? `${lines.join('\n')}\n` : '' });
      }
      case 'has-session': {
        const target = arg('-t') ?? '';
        const scope = model.resolveTarget(target);
        return scope.missing ?? SUCCESS;
      }
      case 'show-environment': {
        const target = arg('-t') ?? '';
        const name = target.replace(/^=/, '').replace(/:$/, '');
        const session = model.sessionByName(name);
        if (!session?.present) return sessionAbsent(name);
        const variable = words[words.length - 1] ?? '';
        if (session.nonce === null) return complete({ stderr: `unknown variable: ${variable}`, exitCode: 1 });
        return complete({ stdout: `${variable}=${session.nonce}\n` });
      }
      case 'list-panes': {
        const fmt = arg('-F') ?? '#{pane_id}';
        const filter = arg('-f');
        if (model.presentSessions().length === 0) return complete({ stderr: 'no server running on /tmp/tmux-501/default', exitCode: 1 });
        const lines: string[] = [];
        for (const session of model.presentSessions()) {
          for (const pane of session.panes.values()) {
            const ctx = { session, pane };
            if (filter && !truthy(model.evaluate(filter, ctx))) continue;
            lines.push(model.evaluate(fmt, ctx));
          }
        }
        return complete({ stdout: lines.length ? `${lines.join('\n')}\n` : '' });
      }
      case 'if-shell': {
        let target: string | undefined;
        let fmt: string | undefined;
        const positional: string[] = [];
        for (let i = 1; i < words.length; i++) {
          const w = words[i]!;
          if (w === '-t') { target = words[++i]; continue; }
          if (w === '-b') continue;
          if (w === '-F') {
            if (words[i + 1] !== undefined && !words[i + 1]!.startsWith('-')) { fmt = words[++i]; }
            continue;
          }
          positional.push(w);
        }
        if (fmt === undefined) fmt = positional.shift() ?? '';
        const thenBranch = positional[0] ?? '';
        const elseBranch = positional[1] ?? '';
        const scope = model.resolveTarget(target);
        if (scope.missing) return scope.missing;
        const chosen = tweak.outcome === 'refused'
          ? null
          : scope.candidates.find(ctx => truthy(model.evaluate(fmt, ctx))) ?? null;
        const ctx = chosen ?? scope.candidates[0]!;
        const out: string[] = [];
        if (tweak.outcome === 'not-applied-lost') return applyOutcome(SUCCESS, tweak);
        const branch = chosen ? thenBranch : elseBranch;
        for (const inner of splitTmuxCommands(branch)) {
          const abort = model.runInner(inner, ctx, out, tweak);
          if (abort) return abort;
        }
        return applyOutcome(complete({ stdout: out.length ? `${out.join('\n')}\n` : '' }), tweak);
      }
      case 'display-message':
      case 'capture-pane':
      case 'send-keys':
      case 'paste-buffer':
      case 'delete-buffer':
      case 'set-option':
      case 'kill-session': {
        const out: string[] = [];
        const target = arg('-t');
        const scope = model.resolveTarget(target);
        if (scope.missing && sub !== 'set-option') return scope.missing;
        // 与 if-shell / load 路径同一语义:命令没到服务端就不能改模型
        if (tweak.outcome === 'not-applied-lost') return applyOutcome(SUCCESS, tweak);
        const abort = model.runInner(trimmed.slice(5), scope.candidates[0]!, out, tweak);
        if (abort) return abort;
        return applyOutcome(complete({ stdout: out.length ? `${out.join('\n')}\n` : '' }), tweak);
      }
      default:
        return SUCCESS;
    }
  };

  const exec = vi.fn<CommandRunner['exec']>(async (command, execOptions) => {
    await options.onExec?.(command, execOptions);
    if (command.includes('send-keys')) sentKeys.push(command);
    const reply = await resolveRule(command, execOptions);
    if (reply && !isTweak(reply)) return complete(reply);
    if (!reply && options.defaultResult) return complete(options.defaultResult);
    return protocol(command, reply ?? {});
  });

  const execWithStdin = vi.fn<CommandRunner['execWithStdin']>(async (command, payload, execOptions) => {
    // 与 exec 同一语义:钩子先于规则求值与模型变更运行,buffer 暂存这一步同样可以挂交错
    await options.onExec?.(command, execOptions);
    const reply = await resolveRule(command, execOptions);
    if (reply && !isTweak(reply)) return complete(reply);
    if (!reply && options.defaultResult) return complete(options.defaultResult);
    const tweak = reply ?? {};
    const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    const plain = /^tmux load-buffer -b '((?:[^']|'\\'')*)' -$/.exec(command.trim());
    if (plain) {
      if (tweak.outcome === 'not-applied-lost') return applyOutcome(SUCCESS, tweak);
      model.staged.set(plain[1]!, body);
      return applyOutcome(SUCCESS, tweak);
    }
    const compound = COMPOUND_LOAD.exec(command.trim());
    if (compound) {
      const [, paneId, fmt, expected, buf] = compound;
      // 命令没到服务端就谈不上身份校验:必须先于 paneOwner/求值返回,否则传输故障会被伪装成确定的身份失败
      if (tweak.outcome === 'not-applied-lost') return applyOutcome(SUCCESS, tweak);
      const owner = model.paneOwner(paneId!);
      if (!owner) return model.paneMissing(paneId!);
      if (model.evaluateMessage(fmt!, owner) !== expected!.replace(/'\\''/g, "'")) return complete({ exitCode: 1 });
      model.staged.set(buf!, body);
      return applyOutcome(SUCCESS, tweak);
    }
    return SUCCESS;
  });

  const sessions: FakeSessions = {
    drop: agentId => { const s = model.sessionByName(agentId); if (s) s.present = false; },
    dropPane: (agentId, paneId) => { model.dropPane(agentId, paneId); },
    reclaim: (agentId, claim) => {
      const s = model.sessionByName(agentId);
      if (!s) return;
      s.claim = claim;
      if (claim === null) s.options.delete('@baxian-agent-id');
      else s.options.set('@baxian-agent-id', claim);
    },
    bumpGeneration: agentId => {
      const s = model.sessionByName(agentId);
      if (!s) return;
      s.serverPid = String(Number(s.serverPid) + 1);
      s.serverStart = String(Number(s.serverStart) + 1);
    },
    seed: (name, opts = {}) => model.seed(name, opts),
    setInterrupt: (agentId, mode) => {
      for (const pane of model.sessionByName(agentId)?.panes.values() ?? []) pane.interrupt = mode;
    },
    // 把 pane 置为 working:给定帧即静态忙碌帧(不自动回 idle),否则用 runtime 默认 working 帧并按 ackHoldCaptures 回落
    markWorking: (agentId, frame) => {
      for (const pane of model.sessionByName(agentId)?.panes.values() ?? []) {
        pane.phase = 'working';
        pane.customFrame = frame ?? null;
        pane.workingCaptures = frame === undefined ? 0 : Number.NEGATIVE_INFINITY;
        const workingTitle = pane.workingTitleOverride ?? RUNTIME_PROFILES[pane.runtime].workingTitle;
        if (workingTitle !== null) pane.title = workingTitle;
      }
    },
    // 前台换成别的进程(vim、node…):shell 名回 shell 相,runtime 名回 idle 相,其它按 other 相处理
    setProcess: (agentId, process) => {
      for (const pane of model.sessionByName(agentId)?.panes.values() ?? []) {
        pane.process = process;
        if (SHELL_PROCESSES.has(process)) { pane.phase = 'shell'; pane.title = SHELL_TITLE; pane.customFrame = null; continue; }
        const runtime = runtimeForProcess(process);
        if (runtime === null) { pane.phase = 'other'; pane.customFrame = pane.customFrame ?? ''; pane.title = process; continue; }
        pane.runtime = runtime;
        pane.phase = 'idle';
        pane.customFrame = null;
        pane.idleTitle = RUNTIME_PROFILES[runtime].idleTitle;
        pane.title = pane.idleTitle;
      }
    },
    present: agentId => model.sessionByName(agentId)?.present ?? false,
    pane: (agentId, paneId) => {
      const s = model.sessionByName(agentId);
      if (!s) return null;
      const pane = paneId ? s.panes.get(paneId) : s.panes.values().next().value;
      if (!pane) return null;
      return {
        id: pane.id,
        process: pane.process,
        phase: pane.phase,
        composer: pane.composer,
        title: pane.title,
        frame: model.render(pane, s, true),
      };
    },
    option: (agentId, key) => model.sessionByName(agentId)?.options.get(key),
  };

  return {
    exec,
    writeFile: vi.fn<CommandRunner['writeFile']>().mockResolvedValue(undefined),
    execWithStdin,
    sentKeys,
    pastedPrompts: model.pastedPrompts,
    sessions,
  };
}

export function clearAwareRunner(
  sentKeys: string[],
  paneInfo: (pane: string) => { proc: string; idle: string },
  options: {
    failClear?: (pane: string) => boolean;
    swallowClearEnters?: number;
    rejectClear?: (pane: string) => boolean;
  } = {},
): CommandRunner {
  const clearTyped = new Set<string>();
  const rejected = new Set<string>();
  const swallowed = new Map<string, number>();
  const paneOf = (command: string): string => command.match(/%\d+/)?.[0] ?? '';
  return fakeRunner({
    onExec: command => {
      if (command.includes('send-keys')) sentKeys.push(command);
    },
    rules: [{
      match: 'send-keys',
      reply: command => {
        const pane = paneOf(command);
        if (command.includes('send-keys -l') && command.includes('/clear')) {
          if (options.failClear?.(pane)) {
            return { stderr: 'tmux send failed', exitCode: 1 };
          }
          clearTyped.add(pane);
        } else if (command.includes("'Enter'") && clearTyped.has(pane)) {
          const swallowedCount = swallowed.get(pane) ?? 0;
          if (swallowedCount < (options.swallowClearEnters ?? 0)) {
            swallowed.set(pane, swallowedCount + 1);
          } else {
            clearTyped.delete(pane);
            if (options.rejectClear?.(pane)) rejected.add(pane);
          }
        }
        return SUCCESS;
      },
    }, {
      // 清稿的 cursor_x|前台 帧交给协议默认回复,那里同时知道光标列与 pane 进程
      match: command => command.includes('display-message')
        && command.includes('pane_current_command')
        && !command.includes('cursor_x')
        && !command.includes('capture-pane'),
      reply: command => ({ stdout: `BX_PANE_OK${paneInfo(paneOf(command)).proc}\n` }),
    }, {
      match: 'capture-pane',
      reply: command => {
        const pane = paneOf(command);
        const info = paneInfo(pane);
        const frame = rejected.has(pane)
          ? `■ '/clear' is disabled while a task is in progress.\n${info.idle}`
          : clearTyped.has(pane) ? `${info.idle} /clear` : info.idle;
        const marker = command.includes('history_size') ? 'BX_PANE_OK|0' : 'BX_PANE_OK';
        return { stdout: `${marker}\n${frame}` };
      },
    }],
  });
}
