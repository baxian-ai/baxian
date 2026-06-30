const TMUX_PREFIX_RE = /\x02/g;

export function sanitizeWebInput(data: string): string {
  if (data.length === 0) return data;
  return data.replace(TMUX_PREFIX_RE, '');
}
