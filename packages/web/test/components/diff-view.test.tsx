import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { parseUnifiedDiff, DiffView } from '../../src/components/diff-view.tsx';

afterEach(() => cleanup());

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

describe('DiffView', () => {
  it('renders an empty-state for empty content', () => {
    render(<DiffView content="" />);
    expect(screen.getByText('无内容')).toBeTruthy();
  });

  it('renders the diffstat and colors add/del lines', () => {
    const { container } = render(
      <DiffView content={'@@ -1 +1 @@\n-old\n+new'} diffstat={'1 file changed, 1 insertion(+), 1 deletion(-)'} />,
    );
    expect(screen.getByText(/1 file changed/)).toBeTruthy();
    const rows = Array.from(container.querySelectorAll('div'));
    const added = rows.find((d) => d.textContent === '+new');
    const removed = rows.find((d) => d.textContent === '-old');
    expect(added?.className).toContain('text-success');
    expect(removed?.className).toContain('text-danger');
  });
});
