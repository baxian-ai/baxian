import { describe, expect, it } from 'vitest';
import {
  buildPhaseSignal,
  createSignalToken,
  PHASE_SIGNAL_KINDS,
  scanInputReceivedSignals,
  scanNeedInputSignals,
  scanPhaseSignalMatches,
  scanPhaseSignals,
  scanTaskCreateSignals,
} from '../../src/agent/phase-signal.js';
import { TITLE_MAX_LEN } from '../../src/shared/index.js';
import { visibleText } from '../../src/agent/vt-visible-text.js';

describe('phase signal protocol', () => {
  it('builds plain signals and PR delivery signals', () => {
    expect(buildPhaseSignal('pr-merge-ready', 'tok345abc')).toBe('[bx:pr-merge-ready:tok345abc]');
    expect(buildPhaseSignal('pr-fixed', 'tok456abc')).toBe('[bx:pr-fixed:tok456abc]');
    expect(buildPhaseSignal('greeting', 'tok456abc')).toBe('[bx:greeting:tok456abc]');
    expect(buildPhaseSignal('spec-done', 'abc123def456', 42))
      .toBe('[bx:spec-done:42:abc123def456]');
    expect(buildPhaseSignal('pr-created', 'tok123def456', 999))
      .toBe('[bx:pr-created:999:tok123def456]');
  });

  it('requires a PR number for delivery signals', () => {
    expect(() => (buildPhaseSignal as (...args: unknown[]) => string)(
      'pr-created', 'abc123def456',
    )).toThrow(/requires prNumber/);
    expect(() => (buildPhaseSignal as (...args: unknown[]) => string)(
      'spec-done', 'abc123def456',
    )).toThrow(/requires prNumber/);
  });

  it('scans only the retained grammar', () => {
    expect(PHASE_SIGNAL_KINDS).toEqual([
      'pr-created', 'pr-fixed', 'pr-merge-ready', 'spec-done', 'greeting',
    ]);
    const text = [
      '[bx:pr-fixed:xyz789def]',
      '[bx:pr-created:7:fff111222333]',
      '[bx:spec-done:42:abc123def456]',
      '[bx:pr-merge-ready:tok111222333]',
    ].join('\n');
    expect(scanPhaseSignals(text)).toEqual([
      { kind: 'pr-fixed', token: 'xyz789def' },
      { kind: 'pr-created', prNumber: 7, token: 'fff111222333' },
      { kind: 'spec-done', prNumber: 42, token: 'abc123def456' },
      { kind: 'pr-merge-ready', token: 'tok111222333' },
    ]);
  });

  it('rejects placeholders, incomplete delivery signals, the retired actor segment, and retired kinds', () => {
    expect(scanPhaseSignals('[bx:spec-done:<token>]')).toEqual([]);
    expect(scanPhaseSignals('[bx:pr-created:<pr_number>:<token>]')).toEqual([]);
    expect(scanPhaseSignals('[bx:spec-done:abcdef123456]')).toEqual([]);
    expect(scanPhaseSignals('[bx:pr-created:42:Nzc:abcdef123456]')).toEqual([]);
    for (const kind of [
      'code-done', 'code-reviewed', 'code-fixed', 'code-ready', 'spec-reviewed', 'spec-fixed',
    ]) {
      expect(scanPhaseSignals(`[bx:${kind}:abcdef123456]`)).toEqual([]);
    }
  });

  it('fuzzy-matches a delivery signal split across lines', () => {
    const wrapped = '[bx:spec-done:4\n  2:abc12\n  3def456]';
    expect(scanPhaseSignals(wrapped)).toEqual([
      { kind: 'spec-done', prNumber: 42, token: 'abc123def456' },
    ]);
  });

  it('matches a marker the terminal shows through SGR colouring', () => {
    const colored = `\x1b[32m[bx:spec-done:42:tokABCDEF]\x1b[0m`;
    expect(scanPhaseSignals(visibleText(colored))).toEqual([
      { kind: 'spec-done', prNumber: 42, token: 'tokABCDEF' },
    ]);
  });

  it.each([
    ['CSI cursor movement', '[bx:pr-\x1b[6Dfixed:tok123abc]'],
    ['carriage-return redraw', '[bx:pr-\rfixed:tok123abc]'],
  ])('does not complete a phase from marker bytes overwritten by %s', (_name, overwritten) => {
    expect(scanPhaseSignals(visibleText(overwritten))).toEqual([]);
  });

  it('ignores unknown kinds and malformed tokens', () => {
    expect(scanPhaseSignals('[bx:unknown-kind:abc123]')).toEqual([]);
    expect(scanPhaseSignals('[bx:spec-done:42:abc]')).toEqual([]);
    expect(scanPhaseSignals('[bx:spec-done:42:tok]extra]')).toEqual([]);
    expect(scanPhaseSignals('[bx:pr-created:abc:tok123abc]')).toEqual([]);
  });

  it('createSignalToken produces 12 hex chars (48 bits)', () => {
    const t = createSignalToken();
    expect(t).toMatch(/^[0-9a-f]{12}$/);
    expect(t).not.toBe(createSignalToken());
  });

  it('scans the visible text, not the raw bytes: OSC/CSI leave only what the terminal prints', () => {
    expect(visibleText('\x1b]0;title\x07\x1b[31mhello\x1b[0m')).toBe('hello');
  });

  it('returns signals in text order', () => {
    const text = '[bx:spec-done:7:tokSpec01234]\nlater\n[bx:pr-created:42:tokPR0123456]';
    expect(scanPhaseSignals(text)).toEqual([
      { kind: 'spec-done', prNumber: 7, token: 'tokSpec01234' },
      { kind: 'pr-created', prNumber: 42, token: 'tokPR0123456' },
    ]);
  });
});

describe('need-input signal', () => {
  it('scans need-input with token', () => {
    expect(scanNeedInputSignals('question?\n[bx:need-input:abcdef123456]\n')).toEqual([
      { token: 'abcdef123456', raw: '[bx:need-input:abcdef123456]', index: 9 },
    ]);
  });

  it('survives ANSI noise and TUI soft-wrap whitespace', () => {
    expect(scanNeedInputSignals(visibleText('\x1b[31m[bx:need-\ninput:abcdef123456]\x1b[0m'))).toEqual([
      { token: 'abcdef123456', raw: '[bx:need-input:abcdef123456]', index: 0 },
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

  it('scans the ordinal form and keeps the bare form seq-less', () => {
    expect(scanNeedInputSignals('[bx:need-input:abcdef123456:3]')).toEqual([
      { token: 'abcdef123456', seq: 3, raw: '[bx:need-input:abcdef123456:3]', index: 0 },
    ]);
    expect(scanNeedInputSignals('[bx:need-input:abcdef123456]')[0]?.seq).toBeUndefined();
  });

  it('rejects malformed ordinals outright instead of degrading to bare', () => {
    expect(scanNeedInputSignals('[bx:need-input:abcdef123456:abc]')).toEqual([]);
    expect(scanNeedInputSignals('[bx:need-input:abcdef123456:12345]')).toEqual([]);
    expect(scanNeedInputSignals('[bx:need-input:abcdef123456:0]')).toEqual([]);
    expect(scanNeedInputSignals('[bx:need-input:abcdef123456:1:2]')).toEqual([]);
  });

  it('scans input-received with the same grammar', () => {
    expect(scanInputReceivedSignals('done\n[bx:input-received:abcdef123456:2]\n')).toEqual([
      { token: 'abcdef123456', seq: 2, raw: '[bx:input-received:abcdef123456:2]', index: 4 },
    ]);
    expect(scanInputReceivedSignals('[bx:input-received:abcdef123456]')).toEqual([
      { token: 'abcdef123456', raw: '[bx:input-received:abcdef123456]', index: 0 },
    ]);
    expect(scanInputReceivedSignals(visibleText('\x1b[2m[bx:input-\nreceived:abcdef123456:7]\x1b[0m'))).toEqual([
      { token: 'abcdef123456', seq: 7, raw: '[bx:input-received:abcdef123456:7]', index: 0 },
    ]);
    expect(scanInputReceivedSignals('[bx:input-received:abcdef123456:00a]')).toEqual([]);
  });
});

describe('scans follow what the terminal actually displays', () => {
  it('ignores a marker embedded in a finished window-title OSC', () => {
    expect(scanPhaseSignals(visibleText('\x1b]0;[bx:pr-fixed:tok123]\x07'))).toEqual([]);
  });

  it('still sees a real marker after a finished OSC', () => {
    expect(scanPhaseSignals(visibleText('\x1b]0;title\x07[bx:pr-fixed:tok123]')))
      .toEqual([{ kind: 'pr-fixed', token: 'tok123' }]);
  });
});

describe('task-create signal', () => {
  const TOKEN = 'abcdef123456';

  it('decodes plus-for-space and reports the raw frame position', () => {
    expect(scanTaskCreateSignals(`note\n[bx:task-create:fix+auth+token+refresh:${TOKEN}]\n`)).toEqual([
      { token: TOKEN, title: 'fix auth token refresh', raw: `[bx:task-create:fix+auth+token+refresh:${TOKEN}]`, index: 4 },
    ]);
  });

  it('keeps CJK titles verbatim and splits title from token at the last colon', () => {
    expect(scanTaskCreateSignals(`[bx:task-create:修复+auth+刷新竞态:${TOKEN}]`)[0]).toMatchObject({
      title: '修复 auth 刷新竞态',
    });
    expect(scanTaskCreateSignals(`[bx:task-create:see+https://x.io/a:b:${TOKEN}]`)[0]).toMatchObject({
      token: TOKEN, title: 'see https://x.io/a:b',
    });
  });

  it('rejects an empty title visibly: zero-length payload, plus padding, trailing colon only', () => {
    expect(scanTaskCreateSignals(`[bx:task-create::${TOKEN}]`)).toEqual([
      { token: TOKEN, reject: 'empty-title', length: 0, raw: `[bx:task-create::${TOKEN}]`, index: 0 },
    ]);
    expect(scanTaskCreateSignals(`[bx:task-create:+++:${TOKEN}]`)[0]).toMatchObject({ reject: 'empty-title', length: 3 });
  });

  it('validates the wire length before decoding: 200 accepted, 201 rejected, padding rejected', () => {
    const ok = 'a'.repeat(TITLE_MAX_LEN);
    expect(scanTaskCreateSignals(`[bx:task-create:${ok}:${TOKEN}]`)[0]).toMatchObject({ title: ok });
    expect(scanTaskCreateSignals(`[bx:task-create:${ok}a:${TOKEN}]`)[0]).toMatchObject({
      reject: 'title-too-long', length: TITLE_MAX_LEN + 1,
    });
    expect(scanTaskCreateSignals(`[bx:task-create:${'+'.repeat(1000)}x:${TOKEN}]`)[0]).toMatchObject({
      reject: 'title-too-long', length: 1001,
    });
    expect(scanTaskCreateSignals(`[bx:task-create:${'x'.repeat(1025)}:${TOKEN}]`)[0]).toMatchObject({
      reject: 'title-too-long', length: 1025,
    });
    const padded = `${'+'.repeat(50)}${'b'.repeat(100)}${'+'.repeat(50)}`;
    expect(scanTaskCreateSignals(`[bx:task-create:${padded}:${TOKEN}]`)[0]).toMatchObject({ title: 'b'.repeat(100) });
  });

  it('counts the limit in UTF-16 code units, like the API and the web: 100 emoji pass, 101 fail', () => {
    const emoji = '😀';
    expect(scanTaskCreateSignals(`[bx:task-create:${emoji.repeat(100)}:${TOKEN}]`)[0]).toMatchObject({ title: emoji.repeat(100) });
    expect(scanTaskCreateSignals(`[bx:task-create:${emoji.repeat(101)}:${TOKEN}]`)[0]).toMatchObject({
      reject: 'title-too-long', length: 202,
    });
  });

  it('never captures a title containing brackets; a nested phase frame is scanned exactly as prose', () => {
    const nested = `[bx:task-create:跟踪[bx:pr-fixed:${TOKEN}]:0123456789ab]`;
    expect(scanTaskCreateSignals(nested)).toEqual([]);
    const inner = scanPhaseSignalMatches(nested).map(m => m.signal);
    expect(inner).toEqual([{ kind: 'pr-fixed', token: TOKEN }]);
    expect(inner).toEqual(scanPhaseSignalMatches(`[bx:pr-fixed:${TOKEN}]`).map(m => m.signal));
  });

  it('survives ANSI noise and TUI hard wraps inside the frame', () => {
    const wrapped = visibleText(`\x1b[2m[bx:task-cre\r\nate:fix+the+bu\r\ng:${TOKEN.slice(0, 5)}\r\n${TOKEN.slice(5)}]\x1b[0m`);
    expect(scanTaskCreateSignals(wrapped)).toEqual([
      { token: TOKEN, title: 'fix the bug', raw: `[bx:task-create:fix+the+bug:${TOKEN}]`, index: 0 },
    ]);
  });

  it('accepts 6-64 char tokens only and ignores the angle-bracket template', () => {
    expect(scanTaskCreateSignals('[bx:task-create:x:abcdef]')).toHaveLength(1);
    expect(scanTaskCreateSignals(`[bx:task-create:x:${'a'.repeat(64)}]`)).toHaveLength(1);
    expect(scanTaskCreateSignals('[bx:task-create:x:abcde]')).toEqual([]);
    expect(scanTaskCreateSignals(`[bx:task-create:x:${'a'.repeat(65)}]`)).toEqual([]);
    expect(scanTaskCreateSignals('[bx:task-create:<title>:<token>]')).toEqual([]);
  });

  it('stays disjoint from phase and need-input frames in mixed output', () => {
    const text = `[bx:need-input:${TOKEN}:1] [bx:task-create:a+b:${TOKEN}] [bx:pr-fixed:${TOKEN}]`;
    expect(scanTaskCreateSignals(text).map(s => ('title' in s ? s.title : s.reject))).toEqual(['a b']);
    expect(scanNeedInputSignals(text)).toHaveLength(1);
    expect(scanPhaseSignals(text)).toEqual([{ kind: 'pr-fixed', token: TOKEN }]);
  });
});
