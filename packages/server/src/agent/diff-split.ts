// Pure helpers for server-mode large-diff batching (spec §7): split a unified
// diff per file, group by directory, pack groups into line-capped batches.

export interface DiffFile {
  path: string;
  text: string;
  lines: number;
}

const FILE_HEADER_RE = /^diff --git a\/(.+?) b\//;

export function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

export function splitDiffByFile(diff: string): DiffFile[] {
  if (diff.trim() === '') return [];
  const out: DiffFile[] = [];
  let current: { path: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    out.push({
      path: current.path,
      text: current.lines.join('\n'),
      lines: current.lines.length,
    });
    current = null;
  };
  for (const line of diff.split('\n')) {
    const m = FILE_HEADER_RE.exec(line);
    if (m) {
      flush();
      current = { path: m[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return out;
}

// 'src/agent/x.ts' → 'src/agent'; root-level files group under '.'.
export function topDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '.' : path.slice(0, idx);
}

export function buildBatches(files: DiffFile[], maxLines: number): DiffFile[][] {
  const groups: Array<{ files: DiffFile[]; lines: number }> = [];
  const indexByDir = new Map<string, number>();
  for (const file of files) {
    const dir = topDir(file.path);
    const existing = indexByDir.get(dir);
    if (existing === undefined) {
      indexByDir.set(dir, groups.length);
      groups.push({ files: [file], lines: file.lines });
    } else {
      groups[existing].files.push(file);
      groups[existing].lines += file.lines;
    }
  }

  const batches: DiffFile[][] = [];
  let pending: DiffFile[] = [];
  let pendingLines = 0;
  const flushPending = () => {
    if (pending.length === 0) return;
    batches.push(pending);
    pending = [];
    pendingLines = 0;
  };

  for (const group of groups) {
    if (group.lines > maxLines) {
      // Oversized group: per-file batches; a single file over the cap still ships alone.
      flushPending();
      for (const file of group.files) batches.push([file]);
      continue;
    }
    if (pendingLines + group.lines > maxLines) flushPending();
    pending.push(...group.files);
    pendingLines += group.lines;
  }
  flushPending();
  return batches;
}
