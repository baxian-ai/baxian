import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import tailwindConfig from '../tailwind.config.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(testDir, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(css|ts|tsx)$/.test(entry) ? [path] : [];
  });
}

function scan(pattern: RegExp): string[] {
  return sourceFiles(srcDir).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return Array.from(source.matchAll(pattern))
      .map((match) => `${relative(srcDir, file).replace(/\\/g, '/')}:${match[0]}`);
  });
}

describe('color budget: ink neutrals + single accent', () => {
  it('bans arbitrary hex color utilities in classNames (colors must come from tokens)', () => {
    expect(
      scan(/(?:bg|text|border|accent|ring|fill|stroke|outline|decoration|divide|caret|placeholder|from|via|to)-\[#[0-9a-fA-F]+\]/g),
    ).toEqual([]);
  });

  it('bans the retired red/green/amber semantic utilities', () => {
    expect(scan(/!?(?:text|bg|border|ring)-(?:danger|success|warn)\b/g)).toEqual([]);
  });

  it('drops the retired status color tokens from the theme', () => {
    const colors = (tailwindConfig.theme?.extend?.colors ?? {}) as Record<string, unknown>;
    for (const retired of ['success', 'warn', 'danger']) {
      expect(colors[retired]).toBeUndefined();
    }
  });

  it('keeps content-level exceptions as named tokens (terminal surface, diff add/del)', () => {
    const colors = (tailwindConfig.theme?.extend?.colors ?? {}) as Record<string, unknown>;
    expect(colors.term).toBe('#fdfdfd');
    expect(colors['diff-add']).toBe('#e6f4ec');
    expect(colors['diff-del']).toBe('#fdecea');
    expect(colors['diff-add-ink']).toBe('#15803d');
    expect(colors['diff-del-ink']).toBe('#b91c1c');
  });

  it('keeps attention pulses finite (WCAG 2.2.2: no looping motion beyond 5s)', () => {
    const css = readFileSync(resolve(srcDir, 'index.css'), 'utf8');
    expect(css).not.toMatch(/animation:[^;]*breathe[^;]*infinite/);
  });
});
