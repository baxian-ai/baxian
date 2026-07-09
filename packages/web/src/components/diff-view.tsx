import { useEffect, useMemo, useState } from 'react';
import type { Finding, FindingSeverity } from '../shared/index.js';
import { useT } from '../i18n/index.tsx';

type DiffLineType = 'file' | 'hunk' | 'add' | 'del' | 'context' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed';

export interface DiffFileSection {
  file: string;
  status: DiffFileStatus;
  adds: number;
  dels: number;
  lines: DiffLine[];
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

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const C_ESCAPES: Record<string, string> = {
  a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '\\': '\\',
};

function cUnescape(s: string): string {
  return s.replace(/\\([abfnrtv"\\]|[0-7]{1,3})/g, (_, esc: string) =>
    C_ESCAPES[esc] ?? String.fromCharCode(parseInt(esc, 8)));
}

// git suffixes --- / +++ paths with a TAB when the name has spaces, and C-quotes
// paths with special chars (core.quotepath=false only spares non-ASCII bytes).
function unquotePath(p: string): string {
  let s = p.endsWith('\t') ? p.slice(0, -1) : p;
  if (s.startsWith('"') && s.endsWith('"')) s = cUnescape(s.slice(1, -1));
  return s;
}

function stripAB(p: string): string {
  const s = unquotePath(p);
  return s.startsWith('a/') || s.startsWith('b/') ? s.slice(2) : s;
}

// Chrome already conveyed by the file header; other file-header lines (mode, rename,
// binary marker) carry information a no-hunk diff would otherwise lose.
function isDiffChrome(text: string): boolean {
  return text.startsWith('diff --git')
    || text.startsWith('index ')
    || text.startsWith('--- ')
    || text.startsWith('+++ ');
}

export function parseDiffFiles(content: string): DiffFileSection[] {
  if (!content) return [];
  const sections: DiffFileSection[] = [];
  let cur: DiffFileSection | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  const ensure = (): DiffFileSection => {
    if (!cur) {
      cur = { file: '', status: 'modified', adds: 0, dels: 0, lines: [] };
      sections.push(cur);
    }
    return cur;
  };

  const rawLines = content.split(/\r?\n/);
  // git diff ends with a newline → split yields a trailing '' that, still in-hunk,
  // would be miscounted as a phantom numbered context line.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  for (const text of rawLines) {
    if (text.startsWith('diff --git')) {
      cur = { file: '', status: 'modified', adds: 0, dels: 0, lines: [] };
      sections.push(cur);
      inHunk = false;
      // non-rename: a/PATH and b/PATH are identical — a backreference resolves the
      // path unambiguously even when it contains spaces or slashes (no --- / +++ to
      // recover from on mode-only / binary diffs). The quoted form covers paths with
      // special chars (tab, quote) where those diffs also lack --- / +++ headers.
      // Renames (differing paths) fall back to `rename to`.
      const bare = text.match(/^diff --git a\/(.+) b\/\1$/);
      const quoted = bare ? null : text.match(/^diff --git "a\/(.+)" "b\/\1"$/);
      if (bare) cur.file = bare[1];
      else if (quoted) cur.file = cUnescape(quoted[1]);
      cur.lines.push({ type: 'file', text });
      continue;
    }
    if (text.startsWith('@@')) {
      const s = ensure();
      const m = text.match(HUNK_RE);
      oldNo = m ? parseInt(m[1], 10) : 0;
      newNo = m ? parseInt(m[2], 10) : 0;
      inHunk = true;
      s.lines.push({ type: 'hunk', text });
      continue;
    }
    if (text.startsWith('\\')) {
      ensure().lines.push({ type: 'meta', text });
      continue;
    }
    if (inHunk) {
      const s = ensure();
      if (text.startsWith('+')) {
        s.lines.push({ type: 'add', text, newLine: newNo });
        newNo++;
        s.adds++;
      } else if (text.startsWith('-')) {
        s.lines.push({ type: 'del', text, oldLine: oldNo });
        oldNo++;
        s.dels++;
      } else {
        s.lines.push({ type: 'context', text, oldLine: oldNo, newLine: newNo });
        oldNo++;
        newNo++;
      }
      continue;
    }
    const s = ensure();
    if (text.startsWith('new file')) s.status = 'added';
    else if (text.startsWith('deleted file')) s.status = 'deleted';
    else if (text.startsWith('rename to ')) {
      s.status = 'renamed';
      s.file = unquotePath(text.slice('rename to '.length));
    } else if (text.startsWith('rename from ')) {
      s.status = 'renamed';
    } else if (text.startsWith('+++ ')) {
      const p = text.slice(4);
      if (p === '/dev/null') s.status = 'deleted';
      else s.file = stripAB(p);
    } else if (text.startsWith('--- ')) {
      const p = text.slice(4);
      if (p !== '/dev/null' && !s.file) s.file = stripAB(p);
    }
    s.lines.push({ type: 'file', text });
  }
  return sections;
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

const SEVERITY_DOT: Record<FindingSeverity, string> = {
  critical: 'finding-dot finding-dot-critical',
  major: 'finding-dot finding-dot-major',
  minor: 'finding-dot',
};

const STATUS_CLASS: Record<DiffFileStatus, string> = {
  modified: 'text-og-500',
  added: 'text-diff-add-ink',
  deleted: 'text-diff-del-ink',
  renamed: 'text-accent',
};

export interface DiffExpandRequest {
  file: string;
  line?: number;
  nonce: number;
}

interface DiffViewProps {
  content: string;
  diffstat?: string;
  findings?: Finding[];
  onFindingClick?: (id: string) => void;
  expandRequest?: DiffExpandRequest;
}

function summaryLine(diffstat?: string): string {
  if (!diffstat) return '';
  const lines = diffstat.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function fileId(file: string): string {
  return `diff-file-${encodeURIComponent(file)}`;
}

function lineId(file: string, newLine: number): string {
  return `diff-${encodeURIComponent(file)}-L${newLine}`;
}

function oldLineId(file: string, oldLine: number): string {
  return `diff-${encodeURIComponent(file)}-OLD${oldLine}`;
}

// A deleted line has no new-side number, so it anchors in its own old-line
// namespace — keeping removed-line findings locatable without colliding with -L ids.
function rowAnchorId(file: string, line: DiffLine): string | undefined {
  if (line.newLine != null) return lineId(file, line.newLine);
  if (line.type === 'del' && line.oldLine != null) return oldLineId(file, line.oldLine);
  return undefined;
}

function findingsForLine(
  file: string,
  line: DiffLine,
  byNewLine: Map<string, Finding[]>,
  byOldLine: Map<string, Finding[]>,
): Finding[] | undefined {
  if (line.newLine != null) return byNewLine.get(`${file}:${line.newLine}`);
  if (line.type === 'del' && line.oldLine != null) return byOldLine.get(`${file}:${line.oldLine}`);
  return undefined;
}

function nextFrame(cb: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 0);
  return () => clearTimeout(id);
}

export function DiffView({ content, diffstat, findings, onFindingClick, expandRequest }: DiffViewProps) {
  const t = useT();
  const sections = useMemo(() => parseDiffFiles(content), [content]);

  const lineIndex = useMemo(() => {
    const newKeys = new Set<string>();
    const delKeys = new Set<string>();
    for (const s of sections) {
      for (const l of s.lines) {
        if (l.newLine != null) newKeys.add(`${s.file}:${l.newLine}`);
        else if (l.type === 'del' && l.oldLine != null) delKeys.add(`${s.file}:${l.oldLine}`);
      }
    }
    return { newKeys, delKeys };
  }, [sections]);

  const { findingsByLine, findingsByOldLine } = useMemo(() => {
    const byNewLine = new Map<string, Finding[]>();
    const byOldLine = new Map<string, Finding[]>();
    const push = (m: Map<string, Finding[]>, key: string, f: Finding) => {
      const arr = m.get(key);
      if (arr) arr.push(f);
      else m.set(key, [f]);
    };
    for (const f of findings ?? []) {
      if (!f.file || f.line == null) continue;
      const key = `${f.file}:${f.line}`;
      if (lineIndex.newKeys.has(key)) push(byNewLine, key, f);
      else if (lineIndex.delKeys.has(key)) push(byOldLine, key, f);
    }
    return { findingsByLine: byNewLine, findingsByOldLine: byOldLine };
  }, [findings, lineIndex]);

  const filesWithFindings = useMemo(() => {
    const s = new Set<string>();
    for (const f of findings ?? []) if (f.file) s.add(f.file);
    return s;
  }, [findings]);

  const initialCollapsed = useMemo(() => {
    const anySectionHasFinding = sections.some((s) => filesWithFindings.has(s.file));
    const collapseRest = !anySectionHasFinding && sections.length > 5;
    const map: Record<string, boolean> = {};
    for (const s of sections) {
      map[s.file] = anySectionHasFinding ? !filesWithFindings.has(s.file) : collapseRest;
    }
    return map;
  }, [sections, filesWithFindings]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(initialCollapsed);
  useEffect(() => setCollapsed(initialCollapsed), [initialCollapsed]);

  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 2000);
    return () => clearTimeout(timer);
  }, [flashId]);

  useEffect(() => {
    if (!expandRequest) return;
    const { file, line } = expandRequest;
    setCollapsed((c) => ({ ...c, [file]: false }));
    let active = true;
    const cancel = nextFrame(() => {
      if (!active) return;
      const ids = line != null
        ? [lineId(file, line), oldLineId(file, line), fileId(file)]
        : [fileId(file)];
      let el: HTMLElement | null = null;
      for (const id of ids) {
        el = document.getElementById(id);
        if (el) break;
      }
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashId(el ? el.id : null);
    });
    return () => { active = false; cancel(); };
  }, [expandRequest?.nonce]);

  if (sections.length === 0) {
    return <div className="text-sm text-og-400">{t.review.noContent}</div>;
  }

  const anyCollapsed = sections.some((s) => collapsed[s.file]);
  const toggleAll = () => {
    const next = anyCollapsed ? false : true;
    setCollapsed(Object.fromEntries(sections.map((s) => [s.file, next])));
  };
  const jumpToFile = (file: string) => {
    setCollapsed((c) => ({ ...c, [file]: false }));
    nextFrame(() => document.getElementById(fileId(file))?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const summary = summaryLine(diffstat);

  return (
    <div>
      <div className="mb-2 rounded-md border border-hairline bg-og-50 p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          {summary
            ? <span className="min-w-0 truncate font-mono text-xs text-og-600">{summary}</span>
            : <span />}
          <button type="button" onClick={toggleAll} className="btn-ghost shrink-0 px-2 py-0.5 text-xs">
            {anyCollapsed ? t.review.expandAll : t.review.collapseAll}
          </button>
        </div>
        <ul className="space-y-0.5">
          {sections.map((s, i) => (
            <li key={`${s.file}-${i}`}>
              <button
                type="button"
                onClick={() => jumpToFile(s.file)}
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left font-mono text-xs hover:bg-surface"
              >
                <span className="min-w-0 flex-1 truncate text-og-700">{s.file || t.review.diffUnnamed}</span>
                {s.adds > 0 && <span className="shrink-0 text-diff-add-ink">+{s.adds}</span>}
                {s.dels > 0 && <span className="shrink-0 text-diff-del-ink">−{s.dels}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="overflow-auto rounded-md border border-hairline bg-surface font-mono text-xs leading-[1.5] [max-height:70vh]">
        {sections.map((s, i) => (
          <FileSection
            key={`${s.file}-${i}`}
            section={s}
            collapsed={!!collapsed[s.file]}
            onToggle={() => setCollapsed((c) => ({ ...c, [s.file]: !c[s.file] }))}
            findingsByLine={findingsByLine}
            findingsByOldLine={findingsByOldLine}
            flashId={flashId}
            onFindingClick={onFindingClick}
          />
        ))}
      </div>
    </div>
  );
}

function FileSection({
  section,
  collapsed,
  onToggle,
  findingsByLine,
  findingsByOldLine,
  flashId,
  onFindingClick,
}: {
  section: DiffFileSection;
  collapsed: boolean;
  onToggle: () => void;
  findingsByLine: Map<string, Finding[]>;
  findingsByOldLine: Map<string, Finding[]>;
  flashId: string | null;
  onFindingClick?: (id: string) => void;
}) {
  const t = useT();
  // Hide only the chrome already shown in the header; keep informative metadata
  // (old/new mode, rename from/to, "Binary files … differ") so no-hunk diffs aren't blank.
  const body = section.lines.filter((l) => l.type !== 'file' || !isDiffChrome(l.text));
  return (
    <div id={fileId(section.file)} className="border-b border-hairline last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 bg-og-50 px-3 py-1.5 text-left"
      >
        <span aria-hidden className="shrink-0 text-og-400">{collapsed ? '▸' : '▾'}</span>
        <span className={`shrink-0 text-xs uppercase ${STATUS_CLASS[section.status]}`}>{section.status}</span>
        <span className="min-w-0 flex-1 truncate font-semibold text-og-700">{section.file || t.review.diffUnnamed}</span>
        {section.adds > 0 && <span className="shrink-0 text-diff-add-ink">+{section.adds}</span>}
        {section.dels > 0 && <span className="shrink-0 text-diff-del-ink">−{section.dels}</span>}
      </button>
      {!collapsed && body.map((line, i) => (
        <DiffRow
          key={i}
          file={section.file}
          line={line}
          findings={findingsForLine(section.file, line, findingsByLine, findingsByOldLine)}
          flashId={flashId}
          onFindingClick={onFindingClick}
        />
      ))}
    </div>
  );
}

function DiffRow({
  file,
  line,
  findings,
  flashId,
  onFindingClick,
}: {
  file: string;
  line: DiffLine;
  findings?: Finding[];
  flashId: string | null;
  onFindingClick?: (id: string) => void;
}) {
  const t = useT();
  const rowId = rowAnchorId(file, line);
  const flashed = rowId != null && flashId === rowId;
  return (
    <div id={rowId} className={`flex ${flashed ? 'ring-2 ring-inset ring-accent' : ''}`}>
      <span className="flex w-5 shrink-0 select-none items-center justify-center gap-0.5 overflow-hidden">
        {(findings ?? []).map((finding) => (
          <button
            key={finding.id}
            type="button"
            title={`${finding.id} ${finding.severity}: ${finding.message.slice(0, 120)}`}
            aria-label={t.review.findingMarker(finding.id)}
            onClick={() => onFindingClick?.(finding.id)}
            className={SEVERITY_DOT[finding.severity]}
          />
        ))}
      </span>
      <span className="w-8 shrink-0 select-none border-r border-hairline px-1 text-right text-og-300">{line.oldLine ?? ''}</span>
      <span className="w-8 shrink-0 select-none border-r border-hairline px-1 text-right text-og-300">{line.newLine ?? ''}</span>
      <div className={`min-w-0 flex-1 whitespace-pre px-2 ${LINE_CLASS[line.type]}`}>{line.text === '' ? ' ' : line.text}</div>
    </div>
  );
}
