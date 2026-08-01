import { vi, type Mock } from 'vitest';
import type {
  CommandRunner,
  ExecOptions,
  ExecResult,
} from '../../src/agent/runner.js';

type RunnerReply =
  | Partial<ExecResult>
  | ((command: string, options?: ExecOptions) => Partial<ExecResult> | Promise<Partial<ExecResult>>);

export interface FakeRunnerRule {
  match: string | RegExp | ((command: string, options?: ExecOptions) => boolean);
  reply: RunnerReply;
}

interface FakeRunnerAgent {
  paneId?: string;
  process?: string;
  screen?: string;
  workdir?: string;
}

export interface FakeRunnerOptions {
  rules?: FakeRunnerRule[];
  defaultResult?: Partial<ExecResult>;
  agents?: Record<string, FakeRunnerAgent>;
  session?: 'present' | 'absent';
  onExec?: (command: string, options?: ExecOptions) => void | Promise<void>;
}

export interface FakeRunner extends CommandRunner {
  exec: Mock<CommandRunner['exec']>;
  writeFile: Mock<CommandRunner['writeFile']>;
  execWithStdin: Mock<CommandRunner['execWithStdin']>;
  sentKeys: string[];
}

const SUCCESS: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const CLAUDE_IDLE = '⏵⏵ bypass permissions on /tmp/repo\n\n>';
const CODEX_IDLE = 'permissions: YOLO mode\n\n›';

function complete(result: Partial<ExecResult>): ExecResult {
  return { ...SUCCESS, ...result };
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

function agentIdFrom(command: string): string {
  return command.match(/@baxian-agent-id},([^}]+)}/)?.[1]
    ?? command.match(/session_name},([^}]+)}/)?.[1]
    ?? (command.includes('%1') ? 'qa-1' : 'dev-1');
}

function paneFor(
  agentId: string,
  overrides: Record<string, FakeRunnerAgent> = {},
): { id: string; process: string; screen: string; workdir: string } {
  const defaults = agentId === 'qa-1'
    ? { id: '%1', process: 'codex', screen: CODEX_IDLE, workdir: '/tmp/qa-repo' }
    : { id: '%0', process: 'claude', screen: CLAUDE_IDLE, workdir: '/tmp/repo' };
  const override = overrides[agentId];
  return {
    id: override?.paneId ?? defaults.id,
    process: override?.process ?? defaults.process,
    screen: override?.screen ?? defaults.screen,
    workdir: override?.workdir ?? defaults.workdir,
  };
}

function protocolReply(
  command: string,
  agents?: Record<string, FakeRunnerAgent>,
  session: FakeRunnerOptions['session'] = 'present',
): ExecResult {
  if (session === 'absent' && (
    command.includes('tmux has-session')
    || command.includes('tmux list-sessions')
    || command.includes('tmux list-panes')
  )) {
    return complete({ stderr: 'session not found', exitCode: 1 });
  }
  const agentId = agentIdFrom(command);
  const pane = paneFor(agentId, agents);
  if (command.includes('tmux list-sessions')) {
    return complete({ stdout: `4242|1700000000|$1|${agentId}\n` });
  }
  if (command.includes('tmux list-panes')) {
    return complete({ stdout: `${pane.id} ${pane.process}\n` });
  }
  if (command.includes('pane_current_command') && !command.includes('capture-pane')) {
    return complete({ stdout: `BX_PANE_OK${pane.process}\n` });
  }
  if (command.includes('pane_current_path')) {
    return complete({ stdout: `BX_PANE_OK${pane.workdir}\n` });
  }
  if (command.includes('pane_width')) return complete({ stdout: 'BX_PANE_OK80\n' });
  if (command.includes('pane_title')) return complete({ stdout: 'BX_PANE_OK\n' });
  if (command.includes('capture-pane')) {
    const marker = command.includes('history_size') ? 'BX_PANE_OK|0' : 'BX_PANE_OK';
    return complete({ stdout: `${marker}\n${pane.screen}` });
  }
  return SUCCESS;
}

export function fakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const sentKeys: string[] = [];
  const exec = vi.fn<CommandRunner['exec']>(async (command, execOptions) => {
    await options.onExec?.(command, execOptions);
    if (command.includes('send-keys')) sentKeys.push(command);
    const rule = options.rules?.find(candidate => matches(candidate.match, command, execOptions));
    if (rule) {
      const result = typeof rule.reply === 'function'
        ? await rule.reply(command, execOptions)
        : rule.reply;
      return complete(result);
    }
    if (options.defaultResult) return complete(options.defaultResult);
    return protocolReply(command, options.agents, options.session);
  });
  return {
    exec,
    writeFile: vi.fn<CommandRunner['writeFile']>().mockResolvedValue(undefined),
    execWithStdin: vi.fn<CommandRunner['execWithStdin']>().mockResolvedValue(SUCCESS),
    sentKeys,
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
      match: command => command.includes('display-message')
        && command.includes('pane_current_command')
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
