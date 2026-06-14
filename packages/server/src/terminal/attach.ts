import type { AgentConfig, HostConfig } from '../shared/index.js';
import { shellQuote, wrapRemoteCommand, sshAuthArgs, sshTarget } from '../agent/runner.js';

export interface AttachCommand {
  file: string;
  args: string[];
  // Extra env (SSH_ASKPASS for password hosts) merged over process.env by the pty/spawn caller.
  env?: Record<string, string>;
}

// `host` is the resolved registry host (caller resolves the agent's ref). NO `-d`: it would detach
// real SSH users sharing the session. No mux/keepalive here — an interactive attach must survive blips.
// focus-events (server option) must be on BEFORE the client attaches, or tmux won't request focus
// reporting from its terminal — set it at attach time so pre-existing servers gain it too.
// set-clipboard external: tmux's own copy-mode copies reach the web client's clipboard via OSC 52,
// while raw OSC 52 emitted directly by pane apps is ignored (a tmux-capable process can still copy).
export function buildAttachInteractiveCommand(agent: AgentConfig, host?: HostConfig): AttachCommand {
  if (agent.mode === 'remote') {
    if (!host) throw new Error(`Remote agent ${agent.id} has no resolved host`);
    return {
      file: 'ssh',
      args: [
        ...sshAuthArgs(host),
        '-o', 'ConnectTimeout=10',
        // Only force -p when the host has an explicit port; inline hosts without one keep ~/.ssh/config Port.
        ...(host.port !== undefined ? ['-p', String(host.port)] : []),
        // Disable SSH's `~` escape — line-anchored `~.` in user keystrokes would close the connection.
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
  // sh -c so a rejected option can't block the attach. tmux's own `;` sequence aborts on the first
  // error and -q only suppresses *unknown options*, not a bad value — a tmux too old for the `external`
  // set-clipboard choice (pre-2.6) would otherwise fail and skip attach-session. Each option is its own
  // best-effort command; `exec` then hands the pty straight to the attach (no lingering shell).
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
