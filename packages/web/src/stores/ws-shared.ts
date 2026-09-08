import { UNAUTHORIZED_EVENT } from '../api.ts';

export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocket;

export function handleAuthRevokedClose(
  event: CloseEvent | undefined,
  connectedToken: string | null,
  currentToken: string | null,
): boolean {
  if (event?.code !== 4401 || connectedToken !== currentToken) return false;
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  return true;
}

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
