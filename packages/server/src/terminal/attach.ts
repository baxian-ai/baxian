import type { AgentConfig, HostConfig } from '../shared/index.js';
import { shellQuote, wrapRemoteCommand, sshAuthArgs, sshTarget } from '../agent/runner.js';

export interface AttachCommand {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

export function buildAttachInteractiveCommand(agent: AgentConfig, host?: HostConfig): AttachCommand {
  if (agent.mode === 'remote') {
    if (!host) throw new Error(`Remote agent ${agent.id} has no resolved host`);
    return {
      file: 'ssh',
      args: [
        ...sshAuthArgs(host),
        '-o', 'ConnectTimeout=10',
        ...(host.port !== undefined ? ['-p', String(host.port)] : []),
        '-e', 'none',
        '-t',
        '--',
        sshTarget(host),
        wrapRemoteCommand(
          `tmux set-option -g focus-events on 2>/dev/null || true; ` +
            `tmux set-option -g set-clipboard external 2>/dev/null || true; ` +
            `tmux -u attach-session -t ${shellQuote(`=${agent.id}`)}`,
          'login-interactive',
        ),
      ],
    };
  }
  const target = shellQuote(`=${agent.id}`);
  return {
    file: 'sh',
    args: [
      '-c',
      `tmux set-option -gq focus-events on 2>/dev/null || true; ` +
        `tmux set-option -g set-clipboard external 2>/dev/null || true; ` +
        `exec tmux -u attach-session -t ${target}`,
    ],
  };
}
