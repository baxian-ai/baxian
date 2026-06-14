export function decodeHex(hex: string): string | undefined {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return undefined;
  try {
    return Buffer.from(hex, 'hex').toString('utf8');
  } catch {
    return undefined;
  }
}

export function sanitizePtySize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value <= 0 || value > 65535) return null;
  return value;
}

export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function extractTokenFromProtocols(
  protocolHeader: string | string[] | undefined,
): string | undefined {
  if (!protocolHeader) return undefined;
  const parts = Array.isArray(protocolHeader)
    ? protocolHeader
    : protocolHeader.split(',');
  for (const raw of parts) {
    const p = raw.trim();
    if (!p.startsWith('baxian.token.')) continue;
    const hex = p.slice('baxian.token.'.length);
    return decodeHex(hex);
  }
  return undefined;
}
