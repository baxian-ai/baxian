import { createHash } from 'node:crypto';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function bodyDigest(body: string): string {
  return sha256Hex(body);
}

export const BODY_DIGEST_SOURCE = '[0-9a-f]{64}';
