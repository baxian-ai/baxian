import { useT } from '../i18n/index.tsx';

export type DiffLineType = 'file' | 'hunk' | 'add' | 'del' | 'context' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

function isFileHeader(line: string): boolean {
  return (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ') ||
    line.startsWith('similarity ') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode')
  );
}

export function parseUnifiedDiff(content: string): DiffLine[] {
  if (!content) return [];
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const text of content.split(/\r?\n/)) {
    let type: DiffLineType;
    if (text.startsWith('@@')) {
      type = 'hunk';
      inHunk = true;
    } else if (text.startsWith('diff --git')) {
      type = 'file';
      inHunk = false;
    } else if (text.startsWith('\\')) {
      type = 'meta';
    } else if (inHunk) {
      type = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'context';
    } else if (isFileHeader(text)) {
      type = 'file';
    } else {
      type = 'context';
    }
    out.push({ type, text });
  }
  return out;
}

// Diff add/del keep the universal red/green convention: they are content, not chrome,
// so they sit outside the ink+accent color budget (same rationale as terminal ANSI colors).
const LINE_CLASS: Record<DiffLineType, string> = {
  file: 'bg-og-50 font-semibold text-og-700',
  hunk: 'bg-accent-soft text-accent',
  add: 'bg-diff-add text-diff-add-ink',
  del: 'bg-diff-del text-diff-del-ink',
  context: 'text-og-700',
  meta: 'text-og-400',
};

export function DiffView({ content, diffstat }: { content: string; diffstat?: string }) {
  const t = useT();
  const lines = parseUnifiedDiff(content);
  if (lines.length === 0) {
    return <div className="text-sm text-og-400">{t.review.noContent}</div>;
  }
  return (
    <div>
      {diffstat && (
        <pre className="mb-2 overflow-x-auto rounded-md border border-hairline bg-og-50 p-3 font-mono text-xs text-og-700">
          {diffstat.trimEnd()}
        </pre>
      )}
      <div className="overflow-auto rounded-md border border-hairline bg-surface font-mono text-xs leading-[1.5] [max-height:70vh]">
        {lines.map((line, i) => (
          <div key={i} className={`whitespace-pre px-3 ${LINE_CLASS[line.type]}`}>
            {line.text === '' ? ' ' : line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
