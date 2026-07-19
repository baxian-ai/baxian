import { createHash } from 'node:crypto';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// digest 线协议（spec §6，core 与 skill 共享唯一定义）：API 解码原文按 UTF-8 取 SHA-256
// 完整小写 hex——不规范化 Unicode/CRLF、不剥标记、不 trim；8-hex 截断只有 32 位空间，
// 能编辑评论者可构造同前缀正文让旧 ack 复活。
export function bodyDigest(body: string): string {
  return sha256Hex(body);
}

// digest 段文法与产出函数同居：ack 线协议解析与 cursor 结构校验都从这里取形状。
export const BODY_DIGEST_SOURCE = '[0-9a-f]{64}';
