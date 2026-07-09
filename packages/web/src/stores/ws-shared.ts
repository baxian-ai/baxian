export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocket;

export function toHex(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}

export const defaultWsFactory: WebSocketFactory = (url, protocols) =>
  protocols && protocols.length > 0
    ? new WebSocket(url, protocols)
    : new WebSocket(url);
