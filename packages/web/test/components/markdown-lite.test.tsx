import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  MarkdownLite,
  MARKDOWN_LITE_MAX_CHARS,
  MARKDOWN_LITE_MAX_NODES,
} from '../../src/components/markdown-lite.tsx';

afterEach(() => cleanup());

function md(text: string): HTMLElement {
  return render(<MarkdownLite text={text} />).container;
}

describe('MarkdownLite headings', () => {
  it('renders all six levels, keeps the # prefix, and scales size/weight by level', () => {
    const c = md('# h1 title\n\n## h2 title\n\n### h3 title\n\n#### h4 title\n\n##### h5 title\n\n###### h6 title');
    const expectations: Array<[string, string, string, string]> = [
      ['h1', '# h1 title', 'text-[18px]', 'font-bold'],
      ['h2', '## h2 title', 'text-[17px]', 'font-bold'],
      ['h3', '### h3 title', 'text-[16px]', 'font-semibold'],
      ['h4', '#### h4 title', 'text-[15px]', 'font-semibold'],
      ['h5', '##### h5 title', 'text-[15px]', 'font-semibold'],
      ['h6', '###### h6 title', 'text-[15px]', 'font-semibold'],
    ];
    for (const [tag, text, size, weight] of expectations) {
      const el = c.querySelector(tag);
      expect(el?.textContent).toBe(text);
      expect(el?.className).toContain(size);
      expect(el?.className).toContain(weight);
    }
  });

  it('does not treat # without a space or 7+ hashes as headings', () => {
    const c = md('#nospace\n\n####### seven');
    expect(c.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
    expect(c.textContent).toContain('#nospace');
    expect(c.textContent).toContain('####### seven');
  });

  it('renders inline markup inside headings', () => {
    const c = md('## has **bold** word');
    expect(c.querySelector('h2 strong')?.textContent).toBe('bold');
    expect(c.querySelector('h2')?.textContent).toBe('## has bold word');
  });
});

describe('MarkdownLite paragraphs and line breaks', () => {
  it('turns single newlines into <br> within a paragraph and blank lines into separate paragraphs', () => {
    const c = md('line one\nline two\n\nsecond para');
    const paras = c.querySelectorAll('p');
    expect(paras).toHaveLength(2);
    expect(paras[0].querySelectorAll('br')).toHaveLength(1);
    expect(paras[0].textContent).toBe('line oneline two');
    expect(paras[1].textContent).toBe('second para');
  });

  it('passes plain text through untouched', () => {
    const c = md('just plain text');
    expect(c.textContent).toBe('just plain text');
    expect(c.querySelector('strong,em,code,a,img')).toBeNull();
  });
});

describe('MarkdownLite emphasis and code', () => {
  it('renders bold, italic, and bold-italic', () => {
    const c = md('**b** and *i* and ***bi***');
    expect(c.querySelector('p > strong')?.textContent).toBe('b');
    expect(c.querySelector('p > em')?.textContent).toBe('i');
    expect(c.querySelector('strong > em')?.textContent).toBe('bi');
  });

  it('renders inline code literally, without nested markup', () => {
    const c = md('see `**not bold**` here');
    expect(c.querySelector('code')?.textContent).toBe('**not bold**');
    expect(c.querySelector('code strong')).toBeNull();
  });

  it('renders fenced code blocks literally and ignores the language tag', () => {
    const c = md('```ts\nconst x = 1;\n# not a heading\n```\nafter');
    const pre = c.querySelector('pre');
    expect(pre?.textContent).toBe('const x = 1;\n# not a heading');
    expect(c.querySelector('h1')).toBeNull();
    expect(c.textContent).toContain('after');
  });

  it('tolerates an unclosed fence to end of input', () => {
    const c = md('```\ntail without close');
    expect(c.querySelector('pre')?.textContent).toBe('tail without close');
  });
});

describe('MarkdownLite links and images', () => {
  it('renders http(s) and mailto links with safe targets', () => {
    const c = md('[docs](https://example.com/a) [mail](mailto:a@b.c)');
    const links = c.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('https://example.com/a');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[1].getAttribute('href')).toBe('mailto:a@b.c');
  });

  it('renders inline markup inside link labels', () => {
    const c = md('[**strong** label](https://example.com)');
    expect(c.querySelector('a strong')?.textContent).toBe('strong');
  });

  it('degrades javascript: links to literal text', () => {
    const c = md('[x](javascript:alert(1))');
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toBe('[x](javascript:alert(1))');
  });

  it('degrades non-http(s) image protocols to literal text', () => {
    const c = md('![bad](javascript:x)');
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('button')).toBeNull();
    expect(c.textContent).toContain('![bad](javascript:x)');
  });

  it('renders githubusercontent-hosted images directly', () => {
    const c = md('![avatar](https://user-images.githubusercontent.com/1/a.png)');
    const img = c.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://user-images.githubusercontent.com/1/a.png');
    expect(img?.getAttribute('alt')).toBe('avatar');
    expect(c.querySelector('button')).toBeNull();
  });

  it('defers untrusted external images behind an explicit load button', () => {
    const c = md('![shot](https://attacker.example/pixel.png)');
    expect(c.querySelector('img')).toBeNull();
    const btn = c.querySelector('button');
    expect(btn?.textContent).toContain('attacker.example');
    expect(btn?.textContent).toContain('shot');
    fireEvent.click(btn!);
    expect(c.querySelector('img')?.getAttribute('src')).toBe('https://attacker.example/pixel.png');
    expect(c.querySelector('button')).toBeNull();
  });

  it('does not autolink bare URLs', () => {
    const c = md('see https://example.com now');
    expect(c.querySelector('a')).toBeNull();
  });
});

describe('MarkdownLite safety', () => {
  it('shows raw HTML as literal text instead of interpreting it', () => {
    const c = md('<script>alert(1)</script> <b>tag</b>');
    expect(c.querySelector('script')).toBeNull();
    expect(c.querySelector('b')).toBeNull();
    expect(c.textContent).toContain('<script>alert(1)</script>');
    expect(c.textContent).toContain('<b>tag</b>');
  });
});

describe('MarkdownLite large-input guards', () => {
  it('renders markdown at the char threshold and falls back to plain <pre> beyond it', () => {
    const within = md('a'.repeat(MARKDOWN_LITE_MAX_CHARS));
    expect(within.querySelector('p')).toBeTruthy();
    expect(within.querySelector('pre')).toBeNull();

    cleanup();
    const over = 'a'.repeat(MARKDOWN_LITE_MAX_CHARS + 1);
    const c = md(over);
    const pre = c.querySelector('pre');
    expect(pre?.textContent).toBe(over);
    expect(c.querySelector('p')).toBeNull();
  });

  it('falls back when dense legal markup would exceed the node budget within the char limit', () => {
    const dense = '`x` '.repeat(10_000);
    expect(dense.length).toBeLessThanOrEqual(MARKDOWN_LITE_MAX_CHARS);
    const c = md(dense);
    expect(c.querySelector('code')).toBeNull();
    expect(c.querySelector('pre')?.textContent).toBe(dense);
  });

  it('merges dense rejected links into a single text node instead of falling back', () => {
    const dense = '[x](y)'.repeat(9_000);
    expect(dense.length).toBeLessThanOrEqual(MARKDOWN_LITE_MAX_CHARS);
    const c = md(dense);
    expect(c.querySelector('pre')).toBeNull();
    const para = c.querySelector('p');
    expect(para?.childNodes).toHaveLength(1);
    expect(para?.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(para?.textContent).toBe(dense);
  });

  it('keeps the node budget constant exported for sizing sanity', () => {
    expect(MARKDOWN_LITE_MAX_NODES).toBeGreaterThan(0);
    expect(MARKDOWN_LITE_MAX_CHARS).toBeGreaterThan(MARKDOWN_LITE_MAX_NODES);
  });

  it('handles adversarial rejected-link floods in bounded time', () => {
    const shapes: Array<[string, string]> = [
      ['unclosed-bracket flood', '['.repeat(MARKDOWN_LITE_MAX_CHARS)],
      ['unclosed-image flood', '!['.repeat(MARKDOWN_LITE_MAX_CHARS / 2)],
      ['no-paren link flood', '[a](x '.repeat(10_922)],
      ['single-far-paren flood', `${'[a](x '.repeat(10_921)})`],
    ];
    for (const [label, text] of shapes) {
      expect(text.length).toBeLessThanOrEqual(MARKDOWN_LITE_MAX_CHARS);
      const started = performance.now();
      const c = md(text);
      const elapsed = performance.now() - started;
      expect(elapsed, `${label} took ${elapsed}ms`).toBeLessThan(500);
      expect(c.textContent).toBe(text);
      cleanup();
    }
  });

  it('renders nothing for non-string input without crashing', () => {
    const c = render(<MarkdownLite text={undefined as unknown as string} />).container;
    expect(c.textContent).toBe('');
    expect(c.querySelector('pre')).toBeNull();
  });
});
