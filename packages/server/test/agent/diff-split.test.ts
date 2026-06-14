import { describe, expect, it } from 'vitest';
import { buildBatches, countLines, splitDiffByFile, topDir } from '../../src/agent/diff-split.js';

function fileDiff(path: string, bodyLines: number): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `+line ${i}`).join('\n');
  return `diff --git a/${path} b/${path}\nindex 000..111 100644\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${bodyLines} @@\n${body}`;
}

describe('splitDiffByFile', () => {
  it('splits a multi-file diff preserving order and content', () => {
    const diff = [fileDiff('src/a.ts', 3), fileDiff('src/sub/b.ts', 2), fileDiff('README.md', 1)].join('\n');
    const files = splitDiffByFile(diff);
    expect(files.map(f => f.path)).toEqual(['src/a.ts', 'src/sub/b.ts', 'README.md']);
    expect(files[0].text.startsWith('diff --git a/src/a.ts')).toBe(true);
    expect(files[1].text).toContain('+++ b/src/sub/b.ts');
  });

  it('returns [] for empty diff', () => {
    expect(splitDiffByFile('')).toEqual([]);
  });
});

describe('topDir', () => {
  it('groups by first path segment chain', () => {
    expect(topDir('src/agent/x.ts')).toBe('src/agent');
    expect(topDir('src/x.ts')).toBe('src');
    expect(topDir('README.md')).toBe('.');
  });
});

describe('buildBatches', () => {
  it('single small group fits one batch', () => {
    const files = splitDiffByFile([fileDiff('src/a.ts', 10), fileDiff('src/b.ts', 10)].join('\n'));
    const batches = buildBatches(files, 100);
    expect(batches).toHaveLength(1);
    expect(batches[0].map(f => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('merges consecutive small groups under the cap', () => {
    const files = splitDiffByFile([
      fileDiff('src/agent/a.ts', 10),
      fileDiff('src/event/b.ts', 10),
      fileDiff('docs/c.md', 10),
    ].join('\n'));
    const batches = buildBatches(files, 100);
    expect(batches).toHaveLength(1);
  });

  it('splits oversized group per-file', () => {
    const files = splitDiffByFile([
      fileDiff('src/big/a.ts', 80),
      fileDiff('src/big/b.ts', 80),
      fileDiff('src/big/c.ts', 80),
    ].join('\n'));
    const batches = buildBatches(files, 100);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    for (const b of batches) {
      expect(b.length).toBe(1);
    }
  });

  it('a single file over the cap still ships alone', () => {
    const files = splitDiffByFile(fileDiff('src/huge.ts', 500));
    const batches = buildBatches(files, 100);
    expect(batches).toHaveLength(1);
    expect(batches[0][0].path).toBe('src/huge.ts');
  });

  it('keeps group boundaries when merging would exceed the cap', () => {
    const files = splitDiffByFile([
      fileDiff('src/agent/a.ts', 60),
      fileDiff('src/event/b.ts', 60),
    ].join('\n'));
    const batches = buildBatches(files, 100);
    expect(batches).toHaveLength(2);
  });
});

describe('countLines', () => {
  it('counts newline-separated lines', () => {
    expect(countLines('a\nb\nc')).toBe(3);
    expect(countLines('')).toBe(0);
  });
});
