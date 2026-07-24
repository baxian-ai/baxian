import type { AgentRuntimeConfig, HostConfig } from '../shared/index.js';
import { shellQuote, wrapRemoteCommand, sshAuthArgs, sshTarget } from '../agent/runner.js';

export interface AttachCommand {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AttachExpectedRef {
  serverPid: string;
  serverStart: string;
  sessionId: string;
  claim: string;
}

// Re-prove the pinned session immediately before attaching it so stale generation references fail closed.
function attachGenerationGuard(expected: AttachExpectedRef): string {
  const identity = `${expected.serverPid}|${expected.serverStart}|${expected.sessionId}|${expected.claim}`;
  const target = shellQuote(`${expected.sessionId}:`);
  // display-message takes the format as its message argument (-p to print); it has no -F flag.
  const probe = `tmux display-message -p -t ${target} '#{pid}|#{start_time}|#{session_id}|#{@baxian-agent-id}' 2>/dev/null`;
  return `[ "$(${probe})" = ${shellQuote(identity)} ] || { echo BX_ATTACH_GENERATION_MISMATCH >&2; exit 47; }`;
}

function remoteCommand(agent: AgentRuntimeConfig, host: HostConfig | undefined, payload: string): AttachCommand {
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
      wrapRemoteCommand(payload, 'login-interactive'),
    ],
  };
}

export function buildAttachInteractiveCommand(
  agent: AgentRuntimeConfig,
  host?: HostConfig,
  expected?: AttachExpectedRef,
  opts: { ignoreSize?: boolean } = {},
): AttachCommand {
  const attachTarget = shellQuote(expected?.sessionId ?? `=${agent.id}`);
  const guard = expected ? `${attachGenerationGuard(expected)}; ` : '';
  const flag = opts.ignoreSize ? '-f ignore-size ' : '';
  if (agent.mode === 'remote') {
    return remoteCommand(
      agent,
      host,
      `tmux set-option -g focus-events on 2>/dev/null || true; ` +
        `tmux set-option -g set-clipboard external 2>/dev/null || true; ` +
        `${guard}tmux -u attach-session ${flag}-t ${attachTarget}`,
    );
  }
  return {
    file: 'sh',
    args: [
      '-c',
      `tmux set-option -gq focus-events on 2>/dev/null || true; ` +
        `tmux set-option -g set-clipboard external 2>/dev/null || true; ` +
        `${guard}exec tmux -u attach-session ${flag}-t ${attachTarget}`,
    ],
  };
}

// The probe must resolve tmux in the SAME shell context the interactive attach uses
// (login-interactive remotely), or PATH skew can gate the flag on a different binary.
export function buildAttachProbeCommand(agent: AgentRuntimeConfig, host?: HostConfig): AttachCommand {
  if (agent.mode === 'remote') {
    return remoteCommand(agent, host, 'tmux -V');
  }
  return { file: 'sh', args: ['-c', 'exec tmux -V'] };
}
