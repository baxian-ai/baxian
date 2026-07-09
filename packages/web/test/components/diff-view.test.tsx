import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Finding } from '../../src/shared/index.js';
import { parseUnifiedDiff, parseDiffFiles, DiffView } from '../../src/components/diff-view.tsx';

afterEach(() => cleanup());

const MULTI = [
  'diff --git a/keep.ts b/keep.ts',
  'index 111..222 100644',
  '--- a/keep.ts',
  '+++ b/keep.ts',
  '@@ -1,3 +1,4 @@',
  ' line1',
  '-line2',
  '+line2new',
  '+line2b',
  ' line3',
  '@@ -10,2 +11,2 @@',
  ' ctx10',
  '-old11',
  '+new11',
  'diff --git a/new.ts b/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.ts',
  '@@ -0,0 +1,2 @@',
  '+alpha',
  '+beta',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-x',
  '-y',
  'diff --git a/old.ts b/renamed.ts',
  'similarity index 90%',
  'rename from old.ts',
  'rename to renamed.ts',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('returns [] for empty content', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('classifies file / hunk / context / add / del lines in order', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      'index 1111111..2222222 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,2 @@',
      ' unchanged',
      '-removed',
      '+added',
    ].join('\n');
    expect(parseUnifiedDiff(diff).map((l) => l.type)).toEqual([
      'file', 'file', 'file', 'file', 'hunk', 'context', 'del', 'add',
    ]);
  });

  it('does not misclassify +++/--- headers as add/del', () => {
    expect(parseUnifiedDiff('--- a/f\n+++ b/f').map((l) => l.type)).toEqual(['file', 'file']);
  });

  it('treats rename/new-file headers as file and "\\ No newline" as meta', () => {
    const lines = parseUnifiedDiff(
      'new file mode 100644\nrename from a\nrename to b\n\\ No newline at end of file',
    );
    expect(lines.map((l) => l.type)).toEqual(['file', 'file', 'file', 'meta']);
  });

  it('classifies additions and deletions inside a hunk', () => {
    expect(parseUnifiedDiff('@@ -0,0 +1,2 @@\n+a\n+b').map((l) => l.type)).toEqual(['hunk', 'add', 'add']);
    expect(parseUnifiedDiff('@@ -1,2 +0,0 @@\n-a\n-b').map((l) => l.type)).toEqual(['hunk', 'del', 'del']);
  });

  it('treats hunk content starting with --- / +++ as del/add, not file headers', () => {
    const diff = '@@ -1,3 +1,3 @@\n----\n++++\n ---';
    expect(parseUnifiedDiff(diff).map((l) => l.type)).toEqual(['hunk', 'del', 'add', 'context']);
  });

  it('still treats real --- / +++ headers as file lines outside a hunk', () => {
    expect(parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1 +1 @@\n+x').map((l) => l.type)).toEqual([
      'file', 'file', 'hunk', 'add',
    ]);
  });

  it('resets hunk state on the next file so headers are not mistaken for content', () => {
    const diff = 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\ndiff --git a/y b/y\n--- a/y\n+++ b/y';
    expect(parseUnifiedDiff(diff).map((l) => l.type)).toEqual([
      'file', 'hunk', 'del', 'file', 'file', 'file',
    ]);
  });

  it('strips CRLF line endings so empty-line and classification stay correct', () => {
    const lines = parseUnifiedDiff('@@ -1 +1 @@\r\n-old\r\n+new\r\n');
    expect(lines.map((l) => l.text)).toEqual(['@@ -1 +1 @@', '-old', '+new', '']);
    expect(lines.map((l) => l.type)).toEqual(['hunk', 'del', 'add', 'context']);
  });
});

describe('parseDiffFiles', () => {
  it('returns [] for empty content', () => {
    expect(parseDiffFiles('')).toEqual([]);
  });

  it('splits into per-file sections with status and add/del counts', () => {
    const files = parseDiffFiles(MULTI);
    expect(files.map((f) => f.file)).toEqual(['keep.ts', 'new.ts', 'gone.ts', 'renamed.ts']);
    expect(files.map((f) => f.status)).toEqual(['modified', 'added', 'deleted', 'renamed']);
    const keep = files[0];
    expect(keep.adds).toBe(3);
    expect(keep.dels).toBe(2);
  });

  it('computes new/old line numbers across multiple hunks', () => {
    const keep = parseDiffFiles(MULTI)[0];
    const byText = (t: string) => keep.lines.find((l) => l.text === t)!;
    expect(byText(' line1')).toMatchObject({ oldLine: 1, newLine: 1 });
    expect(byText('-line2').oldLine).toBe(2);
    expect(byText('-line2').newLine).toBeUndefined();
    expect(byText('+line2new').newLine).toBe(2);
    expect(byText('+line2new').oldLine).toBeUndefined();
    expect(byText('+line2b').newLine).toBe(3);
    expect(byText(' line3')).toMatchObject({ oldLine: 3, newLine: 4 });
    expect(byText(' ctx10')).toMatchObject({ oldLine: 10, newLine: 11 });
    expect(byText('-old11').oldLine).toBe(11);
    expect(byText('+new11').newLine).toBe(12);
  });

  it('numbers added-file and deleted-file hunks correctly', () => {
    const [, added, deleted] = parseDiffFiles(MULTI);
    expect(added.lines.find((l) => l.text === '+alpha')!.newLine).toBe(1);
    expect(added.lines.find((l) => l.text === '+beta')!.newLine).toBe(2);
    expect(deleted.lines.find((l) => l.text === '-x')!.oldLine).toBe(1);
    expect(deleted.lines.find((l) => l.text === '-y')!.oldLine).toBe(2);
  });

  it('ignores "\\ No newline" meta lines when counting', () => {
    const files = parseDiffFiles('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file');
    const s = files[0];
    expect(s.lines.find((l) => l.text === '-a')!.oldLine).toBe(1);
    expect(s.lines.find((l) => l.text === '+b')!.newLine).toBe(1);
    expect(s.lines.some((l) => l.type === 'meta')).toBe(true);
  });

  it('handles CRLF line endings', () => {
    const s = parseDiffFiles('diff --git a/x b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n')[0];
    expect(s.file).toBe('x');
    expect(s.lines.find((l) => l.text === '+b')!.newLine).toBe(1);
    expect(s.lines.find((l) => l.text === '-a')!.oldLine).toBe(1);
  });

  it('strips the trailing tab git appends to space-containing paths', () => {
    // git suffixes --- / +++ paths with a TAB when the name has a space
    const diff = [
      'diff --git a/dir/my file.ts b/dir/my file.ts',
      'index 111..222 100644',
      '--- a/dir/my file.ts\t',
      '+++ b/dir/my file.ts\t',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    expect(parseDiffFiles(diff)[0].file).toBe('dir/my file.ts');
  });

  it('unquotes C-style quoted paths (special chars)', () => {
    const diff = [
      'diff --git "a/x\\"q.ts" "b/x\\"q.ts"',
      '--- "a/x\\"q.ts"',
      '+++ "b/x\\"q.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    expect(parseDiffFiles(diff)[0].file).toBe('x"q.ts');
  });

  it('cleans a renamed target path with a space', () => {
    const diff = [
      'diff --git a/old.ts b/new name.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new name.ts',
    ].join('\n');
    expect(parseDiffFiles(diff)[0].file).toBe('new name.ts');
  });

  it('drops the trailing empty line of a newline-terminated diff (no phantom context)', () => {
    const s = parseDiffFiles('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n')[0];
    expect(s.lines[s.lines.length - 1].text).toBe('+b');
    expect(s.lines.some((l) => l.type === 'context' && l.text === '')).toBe(false);
    expect(s.lines.filter((l) => l.newLine === 2)).toHaveLength(0);
  });

  it('resolves identical non-rename paths with spaces/slashes when no --- / +++ header exists', () => {
    // mode-only change on a file inside a space-containing directory
    const diff = 'diff --git a/design assets/logo.png b/design assets/logo.png\nold mode 100644\nnew mode 100755';
    expect(parseDiffFiles(diff)[0].file).toBe('design assets/logo.png');
  });

  it('C-unescapes quoted paths (tab in name) instead of dropping the backslash', () => {
    const diff = 'diff --git "a/a\\tb.ts" "b/a\\tb.ts"\n--- "a/a\\tb.ts"\n+++ "b/a\\tb.ts"\n@@ -1 +1 @@\n-x\n+y';
    expect(parseDiffFiles(diff)[0].file).toBe('a\tb.ts');
  });

  it('resolves a C-quoted diff --git path when no --- / +++ header exists (mode-only)', () => {
    const diff = 'diff --git "a/a\\tb.txt" "b/a\\tb.txt"\nold mode 100644\nnew mode 100755';
    expect(parseDiffFiles(diff)[0].file).toBe('a\tb.txt');
  });
});

const TWO_FILES = [
  'diff --git a/f1.ts b/f1.ts',
  '--- a/f1.ts',
  '+++ b/f1.ts',
  '@@ -1 +1 @@',
  '-f1old',
  '+f1new',
  'diff --git a/f2.ts b/f2.ts',
  '--- a/f2.ts',
  '+++ b/f2.ts',
  '@@ -1 +1 @@',
  '-f2old',
  '+f2new',
].join('\n');

describe('DiffView folding and gutter', () => {
  it('expands files with findings and collapses the rest by default', () => {
    const findings: Finding[] = [{ id: 'f-1', severity: 'major', message: 'm', file: 'f2.ts', line: 1 }];
    render(<DiffView content={TWO_FILES} findings={findings} />);
    expect(screen.getByText('+f2new')).toBeTruthy();
    expect(screen.queryByText('+f1new')).toBeNull();
  });

  it('expands all files when there are no findings and count is small', () => {
    render(<DiffView content={TWO_FILES} />);
    expect(screen.getByText('+f1new')).toBeTruthy();
    expect(screen.getByText('+f2new')).toBeTruthy();
  });

  it('reveals a collapsed file via the expand-all toggle', () => {
    const findings: Finding[] = [{ id: 'f-1', severity: 'major', message: 'm', file: 'f2.ts', line: 1 }];
    render(<DiffView content={TWO_FILES} findings={findings} />);
    expect(screen.queryByText('+f1new')).toBeNull();
    fireEvent.click(screen.getByText('Expand all'));
    expect(screen.getByText('+f1new')).toBeTruthy();
  });

  it('marks lines with a finding and calls onFindingClick when the marker is clicked', () => {
    const onClick = vi.fn();
    const findings: Finding[] = [{ id: 'f-9', severity: 'critical', message: 'boom', file: 'f2.ts', line: 1 }];
    render(<DiffView content={TWO_FILES} findings={findings} onFindingClick={onClick} />);
    const marker = screen.getByTitle('f-9 critical: boom');
    fireEvent.click(marker);
    expect(onClick).toHaveBeenCalledWith('f-9');
  });

  it('renders one marker per finding when several share a line', () => {
    const onClick = vi.fn();
    const findings: Finding[] = [
      { id: 'f-1', severity: 'major', message: 'first', file: 'f2.ts', line: 1 },
      { id: 'f-2', severity: 'critical', message: 'second', file: 'f2.ts', line: 1 },
    ];
    render(<DiffView content={TWO_FILES} findings={findings} onFindingClick={onClick} />);
    expect(screen.getByTitle('f-1 major: first')).toBeTruthy();
    fireEvent.click(screen.getByTitle('f-2 critical: second'));
    expect(onClick).toHaveBeenCalledWith('f-2');
  });
});

describe('DiffView no-hunk metadata', () => {
  it('shows the "Binary files differ" marker for a binary change', () => {
    const diff = 'diff --git a/img.bin b/img.bin\nindex e59aa70..3f5a627 100644\nBinary files a/img.bin and b/img.bin differ';
    render(<DiffView content={diff} />);
    expect(screen.getByText(/Binary files a\/img\.bin and b\/img\.bin differ/)).toBeTruthy();
  });

  it('keeps old/new mode lines visible for a mode-only change', () => {
    const diff = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755';
    render(<DiffView content={diff} />);
    expect(screen.getByText('old mode 100644')).toBeTruthy();
    expect(screen.getByText('new mode 100755')).toBeTruthy();
  });
});

const DELFILE = [
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-first',
  '-second',
].join('\n');

// A trailing deletion whose old line number never reappears as a new line,
// so it stays a pure old-side anchor (no new/old collision).
const EDIT = [
  'diff --git a/edit.ts b/edit.ts',
  '--- a/edit.ts',
  '+++ b/edit.ts',
  '@@ -1,3 +1,2 @@',
  ' keep1',
  ' keep2',
  '-drop3',
].join('\n');

// old line 1 is deleted while new line 1 is added: the same `line: 1` is both.
const CONFLICT = [
  'diff --git a/c.ts b/c.ts',
  '--- a/c.ts',
  '+++ b/c.ts',
  '@@ -1,1 +1,2 @@',
  '-old1',
  '+new1',
  '+new2',
].join('\n');

describe('DiffView deleted-line anchors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('marks a finding on a deleted line and anchors it in the old-line namespace', () => {
    const findings: Finding[] = [{ id: 'f-d', severity: 'major', message: 'removed', file: 'gone.ts', line: 1 }];
    render(<DiffView content={DELFILE} findings={findings} />);
    const marker = screen.getByTitle('f-d major: removed');
    expect(document.getElementById('diff-gone.ts-OLD1')?.contains(marker)).toBe(true);
  });

  it('marks a deleted line inside an otherwise-modified file', () => {
    const findings: Finding[] = [{ id: 'f-e', severity: 'minor', message: 'dropped', file: 'edit.ts', line: 3 }];
    render(<DiffView content={EDIT} findings={findings} />);
    const marker = screen.getByTitle('f-e minor: dropped');
    expect(document.getElementById('diff-edit.ts-OLD3')?.contains(marker)).toBe(true);
  });

  it('prefers the new line and does not double-mark when a line is both added and deleted', () => {
    const findings: Finding[] = [{ id: 'f-c', severity: 'critical', message: 'conflict', file: 'c.ts', line: 1 }];
    render(<DiffView content={CONFLICT} findings={findings} />);
    expect(screen.getAllByTitle('f-c critical: conflict')).toHaveLength(1);
    const marker = screen.getByTitle('f-c critical: conflict');
    expect(document.getElementById('diff-c.ts-L1')?.contains(marker)).toBe(true);
    expect(document.getElementById('diff-c.ts-OLD1')?.querySelector('button')).toBeNull();
  });

  it('does not mark a finding whose line matches neither a new nor a deleted line', () => {
    const findings: Finding[] = [{ id: 'f-x', severity: 'major', message: 'ghost', file: 'edit.ts', line: 99 }];
    render(<DiffView content={EDIT} findings={findings} />);
    expect(screen.queryByTitle('f-x major: ghost')).toBeNull();
  });

  it('expands to a deleted line, flashes it, and falls back to file top for an absent line', () => {
    const scrolled: (string | undefined)[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };

    const findings: Finding[] = [{ id: 'f-d', severity: 'major', message: 'removed', file: 'gone.ts', line: 2 }];
    const { rerender } = render(<DiffView content={DELFILE} findings={findings} />);

    rerender(<DiffView content={DELFILE} findings={findings} expandRequest={{ file: 'gone.ts', line: 2, nonce: 1 }} />);
    expect(scrolled).toContain('diff-gone.ts-OLD2');
    expect(document.getElementById('diff-gone.ts-OLD2')?.className).toContain('ring-2');

    rerender(<DiffView content={DELFILE} findings={findings} expandRequest={{ file: 'gone.ts', line: 99, nonce: 2 }} />);
    expect(scrolled).toContain('diff-file-gone.ts');
  });
});

describe('DiffView', () => {
  it('renders an empty-state for empty content', () => {
    render(<DiffView content="" />);
    expect(screen.getByText('No content')).toBeTruthy();
  });

  it('renders the diffstat and colors add/del lines', () => {
    const { container } = render(
      <DiffView content={'@@ -1 +1 @@\n-old\n+new'} diffstat={'1 file changed, 1 insertion(+), 1 deletion(-)'} />,
    );
    expect(screen.getByText(/1 file changed/)).toBeTruthy();
    const rows = Array.from(container.querySelectorAll('div'));
    const added = rows.find((d) => d.textContent === '+new');
    const removed = rows.find((d) => d.textContent === '-old');
    expect(added?.className).toContain('text-diff-add-ink');
    expect(removed?.className).toContain('text-diff-del-ink');
  });
});
