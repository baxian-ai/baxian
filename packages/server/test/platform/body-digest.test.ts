import { describe, it, expect } from 'vitest';
import { bodyDigest } from '../../src/platform/body-digest.js';

// core 与 skill 两执行面共享的 golden vectors（spec §6 digest 线协议）：
// 对 API 解码原文按 UTF-8 取 SHA-256 完整小写 hex，不做规范化/剥标记/trim。
const VECTORS: Array<[name: string, body: string, hex: string]> = [
  ['empty string', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['trailing LF', 'hello\n', '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03'],
  ['trailing CRLF', 'hello\r\n', 'cd2eca3535741f27a8ae40c31b0c41d4057a7a7b912b33b9aed86485d1c84676'],
  ['no trailing newline', 'hello', '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'],
  ['unicode text', '评审 ✅', 'c4c04270761c147b6826d65d62692448f065f8ff858268580746c13f54ac536d'],
  [
    'body containing a baxian marker line stays undigested-verbatim',
    'fix applied\n<!-- baxian:reply:ack:issue-comments:100:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->',
    'bd6728068b39e0b34a2b9a7ed44abf51fe5be6f52156c21b4d552d4e01c9f30d',
  ],
];

describe('bodyDigest', () => {
  it.each(VECTORS)('%s', (_name, body, hex) => {
    expect(bodyDigest(body)).toBe(hex);
  });

  it('newline flavor and trailing newline are digest-distinct', () => {
    const digests = new Set(['hello', 'hello\n', 'hello\r\n'].map(bodyDigest));
    expect(digests.size).toBe(3);
  });

  it('always yields 64 lowercase hex characters', () => {
    expect(bodyDigest('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
