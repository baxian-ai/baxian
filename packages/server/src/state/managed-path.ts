import { isAbsolute, relative, resolve } from 'node:path';

// Lexical only by design: symlinks follow plain OS semantics, this gate just stops ordinary `..`/absolute-path escapes.
export function assertInsideManagedDir(baseDir: string, target: string): string {
  const abs = resolve(target);
  const rel = relative(resolve(baseDir), abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to touch ${target}: outside managed dir ${baseDir}`);
  }
  return abs;
}
