import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.css'),
  'utf8',
);

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
