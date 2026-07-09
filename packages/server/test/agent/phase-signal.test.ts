import { describe, expect, it } from 'vitest';
import {
  buildPhaseSignal,
  createSignalToken,
  PHASE_SIGNAL_KINDS,
  scanNeedInputSignals,
  scanPhaseSignals,
  scanReadFileSignals,
  stripSignalAnsi,
} from '../../src/agent/phase-signal.js';

describe('phase signal protocol', () => {
  it('builds [bx:KIND:TOKEN] for plain kinds', () => {
    expect(buildPhaseSignal('spec-done', 'abc123def456')).toBe('[bx:spec-done:abc123def456]');
    expect(buildPhaseSignal('spec-reviewed', 'tok123abc')).toBe('[bx:spec-reviewed:tok123abc]');
    expect(buildPhaseSignal('spec-fixed', 'tok234abc')).toBe('[bx:spec-fixed:tok234abc]');
    expect(buildPhaseSignal('pr-approved', 'tok333abc')).toBe('[bx:pr-approved:tok333abc]');
    expect(buildPhaseSignal('pr-changes-requested', 'tok444abc')).toBe('[bx:pr-changes-requested:tok444abc]');
    expect(buildPhaseSignal('pr-merge-ready', 'tok345abc')).toBe('[bx:pr-merge-ready:tok345abc]');
  });

  it('supports the pr-fixed dev-completion signal (symmetric with spec-fixed)', () => {
    expect(PHASE_SIGNAL_KINDS).toContain('pr-fixed');
    expect(buildPhaseSignal('pr-fixed', 'tok456abc')).toBe('[bx:pr-fixed:tok456abc]');
    expect(scanPhaseSignals('done\n[bx:pr-fixed:xyz789def]')).toEqual([
      { kind: 'pr-fixed', token: 'xyz789def' },
    ]);
    expect(scanPhaseSignals('[bx:pr-fixed:<token>]')).toEqual([]);
  });

  it('handles the greeting bootstrap handshake signal kind', () => {
    expect(PHASE_SIGNAL_KINDS).toContain('greeting');
    expect(buildPhaseSignal('greeting', 'tok456abc')).toBe('[bx:greeting:tok456abc]');
    expect(scanPhaseSignals('hi\n[bx:greeting:abc123def456]')).toEqual([
      { kind: 'greeting', token: 'abc123def456' },
    ]);
    expect(scanPhaseSignals('[bx:greeting:<token>]')).toEqual([]);
  });

  it('builds [bx:pr-created:<num>:<token>] three-segment for pr-created', () => {
    expect(buildPhaseSignal('pr-created', 'abc123def456', 42)).toBe('[bx:pr-created:42:abc123def456]');
    expect(buildPhaseSignal('pr-created', 'tok123def456', 999)).toBe('[bx:pr-created:999:tok123def456]');
  });

  it('buildPhaseSignal(pr-created) without prNumber throws', () => {
    // @ts-expect-error — runtime validation, type system already prevents this
    expect(() => buildPhaseSignal('pr-created', 'abc123def456')).toThrow(/requires prNumber/);
  });

  it('never matches the skill-doc placeholder templates as real signals', () => {
    expect(scanPhaseSignals('[bx:spec-done:<token>]')).toEqual([]);
    expect(scanPhaseSignals('[bx:pr-created:<pr_number>:<token>]')).toEqual([]);
  });

  it('scanPhaseSignals returns kind + token for each plain-kind match', () => {
    const text = 'noise\n[bx:spec-done:abc123]\nmiddle\n[bx:pr-merge-ready:xyz789def]';
    expect(scanPhaseSignals(text)).toEqual([
      { kind: 'spec-done', token: 'abc123' },
      { kind: 'pr-merge-ready', token: 'xyz789def' },
    ]);
  });

  it('scanPhaseSignals extracts prNumber for pr-created signals', () => {
    const text = 'PR opened.\n[bx:pr-created:42:abcdef123456]\ndone.';
    expect(scanPhaseSignals(text)).toEqual([
      { kind: 'pr-created', prNumber: 42, token: 'abcdef123456' },
    ]);
  });

  it('fuzzy-matches a signal split across lines (TUI soft-wrap)', () => {
    const wrapped = '[bx:spec-done:abc12\n  3def456]';
    expect(scanPhaseSignals(wrapped)).toEqual([
      { kind: 'spec-done', token: 'abc123def456' },
    ]);
  });

  it('fuzzy-matches a soft-wrapped pr-created with prNumber', () => {
    const wrapped = '[bx:pr-created:1\n  23:abc12\n  3def456]';
    expect(scanPhaseSignals(wrapped)).toEqual([
      { kind: 'pr-created', prNumber: 123, token: 'abc123def456' },
    ]);
  });

  it('strips ANSI escape sequences before matching', () => {
    const colored = `\x1b[32m[bx:spec-done:tokABCDEF]\x1b[0m`;
    expect(scanPhaseSignals(colored)).toEqual([
      { kind: 'spec-done', token: 'tokABCDEF' },
    ]);
  });

  it('ignores unknown kinds and malformed tokens', () => {
    expect(scanPhaseSignals('[bx:unknown-kind:abc123]')).toEqual([]);
    expect(scanPhaseSignals('[bx:spec-done:abc]')).toEqual([]);
    expect(scanPhaseSignals('[bx:spec-done:tok]extra]')).toEqual([]);
    expect(scanPhaseSignals('[bx:pr-created:abc:tok123abc]')).toEqual([]);
  });

  it('accepts legacy UUID-shaped tokens (with dashes) so cross-upgrade tasks still parse', () => {
    expect(scanPhaseSignals('[bx:spec-done:7f801c59-ec0f-4c9f]')).toEqual([
      { kind: 'spec-done', token: '7f801c59-ec0f-4c9f' },
    ]);
  });

  it('createSignalToken produces 12 hex chars (48 bits)', () => {
    const t = createSignalToken();
    expect(t).toMatch(/^[0-9a-f]{12}$/);
    expect(t).not.toBe(createSignalToken());
  });

  it('strips OSC and CSI terminal control sequences without changing plain text', () => {
    expect(stripSignalAnsi('\x1b]0;title\x07\x1b[31mhello\x1b[0m')).toBe('hello');
  });

  it('returns signals in text order, so first-match-wins respects pane sequence (e.g. spec-done before pr-created)', () => {
    const text = '[bx:spec-done:tokSpec01234]\nlater\n[bx:pr-created:42:tokPR0123456]';
    expect(scanPhaseSignals(text)).toEqual([
      { kind: 'spec-done', token: 'tokSpec01234' },
      { kind: 'pr-created', prNumber: 42, token: 'tokPR0123456' },
    ]);
  });

  it('scans both pr-created and plain-kind signals in the same text', () => {
    const text = [
      '[bx:spec-done:abc123def456]',
      '[bx:pr-created:7:fff111222333]',
      '[bx:pr-merge-ready:tok111222333]',
    ].join('\n');
    const sigs = scanPhaseSignals(text);
    expect(sigs).toEqual(expect.arrayContaining([
      { kind: 'spec-done', token: 'abc123def456' },
      { kind: 'pr-created', prNumber: 7, token: 'fff111222333' },
      { kind: 'pr-merge-ready', token: 'tok111222333' },
    ]));
    expect(sigs).toHaveLength(3);
  });

  it('scans server-mode plain kinds', () => {
    for (const kind of ['spec-done', 'spec-reviewed', 'code-done', 'code-reviewed', 'code-fixed'] as const) {
      expect(scanPhaseSignals(`x [bx:${kind}:abcdef123456] y`)).toEqual([
        { kind, token: 'abcdef123456' },
      ]);
      expect(buildPhaseSignal(kind, 'tok123abc')).toBe(`[bx:${kind}:tok123abc]`);
      expect(scanPhaseSignals(`[bx:${kind}:<token>]`)).toEqual([]);
    }
  });

  it('scans code-ready with and without pr number', () => {
    expect(scanPhaseSignals('[bx:code-ready:42:abcdef123456]')).toEqual([
      { kind: 'code-ready', prNumber: 42, token: 'abcdef123456' },
    ]);
    expect(scanPhaseSignals('[bx:code-ready:abcdef123456]')).toEqual([
      { kind: 'code-ready', token: 'abcdef123456' },
    ]);
    expect(buildPhaseSignal('code-ready', 'tok123abc')).toBe('[bx:code-ready:tok123abc]');
    expect(buildPhaseSignal('code-ready', 'tok123abc', 7)).toBe('[bx:code-ready:7:tok123abc]');
  });

  it('code-ready template echo does not fire the scanner', () => {
    expect(scanPhaseSignals('[bx:code-ready:<pr_number>:<token>]')).toEqual([]);
    expect(scanPhaseSignals('[bx:code-ready:<token>]')).toEqual([]);
  });
});

describe('need-input signal', () => {
  it('scans need-input with token', () => {
    expect(scanNeedInputSignals('question?\n[bx:need-input:abcdef123456]\n')).toEqual([
      { token: 'abcdef123456', raw: '[bx:need-input:abcdef123456]' },
    ]);
  });

  it('survives ANSI noise and TUI soft-wrap whitespace', () => {
    expect(scanNeedInputSignals('\x1b[31m[bx:need-\ninput:abcdef123456]\x1b[0m')).toEqual([
      { token: 'abcdef123456', raw: '[bx:need-input:abcdef123456]' },
    ]);
  });

  it('ignores the angle-bracket template and malformed tokens', () => {
    expect(scanNeedInputSignals('[bx:need-input:<token>]')).toEqual([]);
    expect(scanNeedInputSignals('[bx:need-input:short]')).toEqual([]);
    expect(scanNeedInputSignals('[bx:need-input:]')).toEqual([]);
  });

  it('scans multiple occurrences', () => {
    const text = '[bx:need-input:abcdef123456] later [bx:need-input:abcdef123456]';
    expect(scanNeedInputSignals(text)).toHaveLength(2);
  });
});

describe('read-file signal', () => {
  it('scans read-file requests', () => {
    expect(scanReadFileSignals('see [bx:read-file:src/a/b.ts:80-120] then')).toEqual([
      { file: 'src/a/b.ts', startLine: 80, endLine: 120, raw: '[bx:read-file:src/a/b.ts:80-120]' },
    ]);
  });

  it('scans multiple requests and survives ANSI noise', () => {
    const text = '\x1b[31m[bx:read-file:a.ts:1-10]\x1b[0m [bx:read-file:dir/c.py:5-7]';
    expect(scanReadFileSignals(text)).toHaveLength(2);
  });

  it('ignores malformed ranges', () => {
    expect(scanReadFileSignals('[bx:read-file:a.ts:x-10]')).toEqual([]);
    expect(scanReadFileSignals('[bx:read-file:a.ts:10]')).toEqual([]);
  });
});
