import type { AgentStore } from '../state/agent-store.js';
import type { TmuxSessionStatusStore } from './tmux-probe-poller.js';
import type { PaneStreamerManager } from './pane-streamer-manager.js';
import { canDispatchWithBinding } from './manager.js';

export interface LivenessDeps {
  agentStore: AgentStore;
  tmuxSessionStatusStore: TmuxSessionStatusStore;
  paneStreamerManager?: PaneStreamerManager;
}

// An agent occupies its host machine when it is bound to active work / mid-bootstrap / awaiting_human
// (canDispatchWithBinding=false), has a live tmux pane, a probe-observed present session, or an open
// web terminal streamer. Moving its host endpoint under any of these would orphan the live session.
export async function agentIsLive(deps: LivenessDeps, agentId: string): Promise<boolean> {
  const binding = await deps.agentStore.get(agentId);
  const tmux = deps.tmuxSessionStatusStore.get(agentId).tmuxSessionStatus;
  const hasStreamer = deps.paneStreamerManager?.has(agentId) ?? false;
  return !canDispatchWithBinding(binding) || !!binding?.paneId || tmux === 'present' || hasStreamer;
}
