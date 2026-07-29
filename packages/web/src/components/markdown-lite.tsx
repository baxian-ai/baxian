import { useMemo, useState, type ReactNode } from 'react';
import { useT } from '../i18n/index.tsx';

export const MARKDOWN_LITE_MAX_CHARS = 65_536;
export const MARKDOWN_LITE_MAX_NODES = 8_000;

const HEADING_CLASS = [
  'text-[18px] font-bold',
  'text-[17px] font-bold',
  'text-[16px] font-semibold',
  'text-[15px] font-semibold',
  'text-[15px] font-semibold',
  'text-[15px] font-semibold',
];

const LINK_PROTOCOL = /^(https?:\/\/|mailto:)/i;
const IMAGE_PROTOCOL = /^https?:\/\//i;

function isTrustedImageHost(src: string): boolean {
  try {
    const host = new URL(src).hostname.toLowerCase();
    return host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

function MdImage({ src, alt }: { src: string; alt: string }) {
  const t = useT();
  const [load, setLoad] = useState(false);
  if (load || isTrustedImageHost(src)) {
    return <img src={src} alt={alt} loading="lazy" className="max-w-full rounded border border-hairline" />;
  }
  let host = src;
  try {
    host = new URL(src).hostname;
  } catch {
    host = src;
  }
  return (
    <button
      type="button"
      onClick={() => setLoad(true)}
      className="inline-flex max-w-full items-center gap-1.5 rounded border border-hairline bg-og-25 px-2 py-1 text-xs text-og-700"
    >
      <span className="shrink-0">{t.review.loadExternalImage}</span>
      {alt && <span className="min-w-0 truncate text-og-500">{alt}</span>}
      <span className="min-w-0 truncate font-mono text-og-400">{host}</span>
    </button>
  );
}

function makeScanner(text: string, needle: string): (start: number) => number {
  let cachedFrom = -1;
  let cachedAt = -2;
  return (start) => {
    if (cachedAt !== -2 && start >= cachedFrom && (cachedAt === -1 || start <= cachedAt)) {
      return cachedAt;
    }
    cachedFrom = start;
    cachedAt = text.indexOf(needle, start);
    return cachedAt;
  };
}

function makeWhitespaceScanner(text: string): (start: number) => number {
  const re = /\s/g;
  let cachedFrom = -1;
  let cachedAt = -2;
  return (start) => {
    if (cachedAt !== -2 && start >= cachedFrom && (cachedAt === -1 || start <= cachedAt)) {
      return cachedAt;
    }
    cachedFrom = start;
    re.lastIndex = start;
    const m = re.exec(text);
    cachedAt = m ? m.index : -1;
    return cachedAt;
  };
}

interface LinkScanners {
  bracket: (start: number) => number;
  paren: (start: number) => number;
  whitespace: (start: number) => number;
}

interface LinkMatch {
  label: string;
  url: string;
  end: number;
}

function matchLinkLike(text: string, openBracketAt: number, scan: LinkScanners): LinkMatch | null {
  const labelStart = openBracketAt + 1;
  const labelEnd = scan.bracket(labelStart);
  if (labelEnd === -1 || text[labelEnd + 1] !== '(') return null;
  const urlStart = labelEnd + 2;
  const parenAt = scan.paren(urlStart);
  if (parenAt === -1 || parenAt === urlStart) return null;
  const wsAt = scan.whitespace(urlStart);
  if (wsAt !== -1 && wsAt < parenAt) return null;
  return { label: text.slice(labelStart, labelEnd), url: text.slice(urlStart, parenAt), end: parenAt + 1 };
}

class BudgetExceeded extends Error {}

class Budget {
  private count = 0;
  constructor(private readonly max: number) {}
  charge(): void {
    if (++this.count > this.max) throw new BudgetExceeded();
  }
}

function parseInline(text: string, budget: Budget, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  const scan: LinkScanners = {
    bracket: makeScanner(text, ']'),
    paren: makeScanner(text, ')'),
    whitespace: makeWhitespaceScanner(text),
  };
  const flush = () => {
    if (buf === '') return;
    budget.charge();
    out.push(buf);
    buf = '';
  };
  const el = (node: ReactNode) => {
    flush();
    budget.charge();
    out.push(node);
  };
  const key = () => `${keyBase}-${out.length}`;

  while (i < text.length) {
    const ch = text[i];
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close !== -1) {
        const content = text.slice(i + 1, close);
        flush();
        budget.charge();
        budget.charge();
        out.push(
          <code key={key()} className="rounded bg-og-25 px-1 font-mono text-xs">
            {content}
          </code>,
        );
        i = close + 1;
        continue;
      }
    } else if (ch === '!' && text[i + 1] === '[') {
      const m = matchLinkLike(text, i + 1, scan);
      if (m) {
        if (IMAGE_PROTOCOL.test(m.url)) {
          el(<MdImage key={key()} src={m.url} alt={m.label} />);
        } else {
          buf += text.slice(i, m.end);
        }
        i = m.end;
        continue;
      }
    } else if (ch === '[') {
      const m = matchLinkLike(text, i, scan);
      if (m) {
        if (LINK_PROTOCOL.test(m.url)) {
          flush();
          budget.charge();
          const label = parseInline(m.label, budget, `${keyBase}-a${out.length}`);
          out.push(
            <a
              key={key()}
              href={m.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-accent-hover"
            >
              {label}
            </a>,
          );
        } else {
          buf += text.slice(i, m.end);
        }
        i = m.end;
        continue;
      }
    } else if (ch === '*') {
      if (text.startsWith('***', i)) {
        const close = text.indexOf('***', i + 3);
        if (close > i + 3) {
          flush();
          budget.charge();
          budget.charge();
          const inner = parseInline(text.slice(i + 3, close), budget, `${keyBase}-bi${out.length}`);
          out.push(
            <strong key={key()}>
              <em>{inner}</em>
            </strong>,
          );
          i = close + 3;
          continue;
        }
      }
      if (text.startsWith('**', i)) {
        const close = text.indexOf('**', i + 2);
        if (close > i + 2) {
          flush();
          budget.charge();
          const inner = parseInline(text.slice(i + 2, close), budget, `${keyBase}-b${out.length}`);
          out.push(<strong key={key()}>{inner}</strong>);
          i = close + 2;
          continue;
        }
      }
      const close = text.indexOf('*', i + 1);
      if (close > i + 1) {
        flush();
        budget.charge();
        const inner = parseInline(text.slice(i + 1, close), budget, `${keyBase}-i${out.length}`);
        out.push(<em key={key()}>{inner}</em>);
        i = close + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function parseBlocks(text: string, budget: Budget): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const own = paragraph;
    paragraph = [];
    budget.charge();
    const children: ReactNode[] = [];
    own.forEach((line, idx) => {
      if (idx > 0) {
        budget.charge();
        children.push(<br key={`br-${blocks.length}-${idx}`} />);
      }
      children.push(...parseInline(line, budget, `p${blocks.length}-l${idx}`));
    });
    blocks.push(<p key={`p-${blocks.length}`}>{children}</p>);
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (line.startsWith('```')) {
      flushParagraph();
      const body: string[] = [];
      let m = n + 1;
      while (m < lines.length && !/^```\s*$/.test(lines[m])) {
        body.push(lines[m]);
        m++;
      }
      budget.charge();
      budget.charge();
      budget.charge();
      blocks.push(
        <pre key={`pre-${blocks.length}`} className="overflow-x-auto rounded bg-og-25 p-2 font-mono text-xs">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      n = m;
      continue;
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      budget.charge();
      const level = heading[1].length;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(
        <Tag key={`h-${blocks.length}`} className={HEADING_CLASS[level - 1]}>
          {parseInline(line, budget, `h${blocks.length}`)}
        </Tag>,
      );
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

function renderMarkdown(text: string): ReactNode[] | null {
  if (typeof text !== 'string') return [];
  if (text.length > MARKDOWN_LITE_MAX_CHARS) return null;
  const budget = new Budget(MARKDOWN_LITE_MAX_NODES);
  try {
    budget.charge();
    return parseBlocks(text.replace(/\r\n/g, '\n'), budget);
  } catch (err) {
    if (err instanceof BudgetExceeded) return null;
    throw err;
  }
}

export function MarkdownLite({ text }: { text: string }) {
  const blocks = useMemo(() => renderMarkdown(text), [text]);
  if (blocks === null) {
    return <pre className="whitespace-pre-wrap break-words">{text}</pre>;
  }
  return <div className="space-y-2 break-words">{blocks}</div>;
}
