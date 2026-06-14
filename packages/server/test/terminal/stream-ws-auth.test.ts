import { describe, it, expect } from 'vitest';
import {
  decodeHex,
  extractTokenFromProtocols,
  isAllowedOrigin,
  sanitizePtySize,
} from '../../src/terminal/ws-auth.js';

const toHex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');

describe('ws-auth', () => {
  describe('decodeHex', () => {
    it('round-trips arbitrary token strings', () => {
      const tokens = ['abc-123', '中文 token', 'a/b+c=d', ''];
      for (const t of tokens) expect(decodeHex(toHex(t))).toBe(t);
    });

    it('returns undefined on non-hex / odd-length input', () => {
      expect(decodeHex('zzzz')).toBeUndefined();
      expect(decodeHex('abc')).toBeUndefined();
    });
  });

  describe('sanitizePtySize', () => {
    it('accepts positive integers up to 65535', () => {
      expect(sanitizePtySize(1)).toBe(1);
      expect(sanitizePtySize(80)).toBe(80);
      expect(sanitizePtySize(65535)).toBe(65535);
    });

    it('rejects 0, negative, fractional, > 65535, non-number', () => {
      expect(sanitizePtySize(0)).toBeNull();
      expect(sanitizePtySize(-1)).toBeNull();
      expect(sanitizePtySize(1.5)).toBeNull();
      expect(sanitizePtySize(65536)).toBeNull();
      expect(sanitizePtySize('80')).toBeNull();
      expect(sanitizePtySize(null)).toBeNull();
      expect(sanitizePtySize(undefined)).toBeNull();
      expect(sanitizePtySize(1e9)).toBeNull();
    });
  });

  describe('isAllowedOrigin', () => {
    it('allows missing Origin (curl / Node clients)', () => {
      expect(isAllowedOrigin(undefined, 'localhost:3000')).toBe(true);
    });

    it('allows same-host Origin', () => {
      expect(isAllowedOrigin('http://localhost:3000', 'localhost:3000')).toBe(true);
      expect(isAllowedOrigin('https://localhost:3000', 'localhost:3000')).toBe(true);
    });

    it('rejects cross-host Origin', () => {
      expect(isAllowedOrigin('http://evil.example', 'localhost:3000')).toBe(false);
    });

    it('rejects when host is missing but origin is present (proxy mis-config)', () => {
      expect(isAllowedOrigin('http://localhost', undefined)).toBe(false);
    });

    it('rejects malformed Origin gracefully', () => {
      expect(isAllowedOrigin('not a url', 'localhost:3000')).toBe(false);
    });
  });

  describe('extractTokenFromProtocols (Sec-WebSocket-Protocol)', () => {
    it('returns undefined when no protocol header', () => {
      expect(extractTokenFromProtocols(undefined)).toBeUndefined();
    });

    it('parses single protocol string with comma-joined list', () => {
      const tok = 's3cret-token';
      expect(extractTokenFromProtocols(`baxian.token.${toHex(tok)}`)).toBe(tok);
    });

    it('parses array form (some clients pass as string[])', () => {
      const tok = 's3cret';
      expect(extractTokenFromProtocols(['other-proto', `baxian.token.${toHex(tok)}`])).toBe(tok);
    });

    it('parses comma-joined string with multiple protocols', () => {
      const tok = 'a/b+c=d';
      const header = `binary.proto, baxian.token.${toHex(tok)}, foo`;
      expect(extractTokenFromProtocols(header)).toBe(tok);
    });

    it('returns undefined when no baxian.token.<hex> matches', () => {
      expect(extractTokenFromProtocols('binary.proto, foo')).toBeUndefined();
    });

    it('returns undefined when hex portion is malformed', () => {
      expect(extractTokenFromProtocols('baxian.token.zzzz')).toBeUndefined();
      expect(extractTokenFromProtocols('baxian.token.abc')).toBeUndefined();  // odd length
    });
  });
});
