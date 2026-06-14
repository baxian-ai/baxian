// Strip tmux prefix byte (0x02) — paired with session prefix=C-b lock in AgentManager
// to keep one web subscriber from invoking detach-client / new-window / etc on shared pane.
const TMUX_PREFIX_RE = /\x02/g;

export function sanitizeWebInput(data: string): string {
  if (data.length === 0) return data;
  return data.replace(TMUX_PREFIX_RE, '');
}
