import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(testDir, '..', 'src');
const css = readFileSync(
  resolve(srcDir, 'index.css'),
  'utf8',
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(css|ts|tsx)$/.test(entry) ? [path] : [];
  });
}

describe('index.css base typography', () => {
  it('sets the base body font-size to the original 14px baseline', () => {
    const body = css.match(/body\s*\{([\s\S]*?)\}/);
    expect(body).not.toBeNull();
    expect(body![1]).toMatch(/font-size:\s*14px/);
  });

  it('limits app font-size utilities to xs and sm', () => {
    const allowed = new Set(['text-xs', 'text-sm']);
    // Markdown 标题按需求必须比 14px 正文稍大且分级；豁免仅限该文件的四个刻度。
    const fileExceptions: Record<string, Set<string>> = {
      'components/markdown-lite.tsx': new Set(['text-[18px]', 'text-[17px]', 'text-[16px]', 'text-[15px]']),
    };
    const disallowed = sourceFiles(srcDir).flatMap((file) => {
      const rel = relative(srcDir, file).replace(/\\/g, '/');
      const source = readFileSync(file, 'utf8');
      return Array.from(source.matchAll(/!?text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl|\[(?!#)[^\]]+\])/g))
        .map((match) => match[0])
        .filter((token) => !allowed.has(token) && !fileExceptions[rel]?.has(token))
        .map((token) => `${rel}:${token}`);
    });

    expect(disallowed).toEqual([]);
  });

  it('limits raw font-size declarations to the 14px body baseline, the 16px touch form exception, and the 13px xterm option', () => {
    const hits = sourceFiles(srcDir).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return Array.from(source.matchAll(/font-?[Ss]ize\s*[:=]\s*['"]?[\d.]+(?:px)?/g))
        .map((match) => `${relative(srcDir, file).replace(/\\/g, '/')}:${match[0]}`);
    });

    expect(hits.sort()).toEqual([
      'components/pane-terminal.tsx:fontSize: 13',
      'index.css:font-size: 14px',
      'index.css:font-size: 16px',
    ]);
  });
});

describe('index.css mobile rules', () => {
  it('disables iOS landscape text inflation via text-size-adjust on the body', () => {
    expect(css).toMatch(/-webkit-text-size-adjust:\s*100%/);
    expect(css).toMatch(/(?:^|[^-])text-size-adjust:\s*100%/);
  });

  it('pins form controls to 16px on touch devices so focusing a field never triggers iOS zoom', () => {
    const coarse = css.match(/@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\}\s*\}/);
    expect(coarse).not.toBeNull();
    const block = coarse![0];
    expect(block).toMatch(/\binput\b/);
    expect(block).toMatch(/\bselect\b/);
    expect(block).toMatch(/\btextarea\b/);
    expect(block).toMatch(/font-size:\s*16px\s*!important/);
  });

  it('excludes non-text inputs (checkbox/radio/button/submit/file) that never trigger iOS zoom', () => {
    const coarse = css.match(/@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\}\s*\}/);
    const block = coarse![0];
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'file']) {
      expect(block).toMatch(new RegExp(`:not\\(\\[type="${type}"\\]\\)`));
    }
  });

  it('provides a scrollbar-none utility (incl. webkit) for single-line rows that degrade to scroll', () => {
    expect(css).toMatch(/\.scrollbar-none\s*\{[^}]*scrollbar-width:\s*none/);
    expect(css).toMatch(/\.scrollbar-none::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
  });
});
