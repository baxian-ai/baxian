import { describe, expect, it } from 'vitest';
import {
  buildPhaseSignal,
  createSignalToken,
  decodeSignalActorId,
  PHASE_SIGNAL_KINDS,
  scanInputReceivedSignals,
  scanNeedInputSignals,
  scanPhaseSignals,
  scanRootDoneSignals,
} from '../../src/agent/phase-signal.js';
import { visibleText } from '../../src/agent/vt-visible-text.js';

describe('phase signal protocol', () => {
  it('builds plain signals and PR delivery signals', () => {
    expect(buildPhaseSignal('pr-merge-ready', 'tok345abc')).toBe('[bx:pr-merge-ready:tok345abc]');
    expect(buildPhaseSignal('pr-fixed', 'tok456abc')).toBe('[bx:pr-fixed:tok456abc]');
    expect(buildPhaseSignal('greeting', 'tok456abc')).toBe('[bx:greeting:tok456abc]');
    expect(buildPhaseSignal('spec-done', 'abc123def456', 42, 'Nzc'))
      .toBe('[bx:spec-done:42:Nzc:abc123def456]');
    expect(buildPhaseSignal('pr-created', 'tok123def456', 999, 'Nzc'))
      .toBe('[bx:pr-created:999:Nzc:tok123def456]');
  });

  it('requires both PR number and actor for delivery signals', () => {
    expect(() => (buildPhaseSignal as (...args: unknown[]) => string)(
      'pr-created', 'abc123def456',
    )).toThrow(/requires prNumber and actorB64/);
    expect(() => (buildPhaseSignal as (...args: unknown[]) => string)(
      'spec-done', 'abc123def456', 42,
    )).toThrow(/requires prNumber and actorB64/);
  });

  it('scans only the retained grammar', () => {
    expect(PHASE_SIGNAL_KINDS).toEqual([
      'pr-created', 'pr-fixed', 'pr-merge-ready', 'spec-done', 'greeting',
    ]);
    const text = [
      '[bx:pr-fixed:xyz789def]',
      '[bx:pr-created:7:Nzc:fff111222333]',
      '[bx:spec-done:42:Nzc:abc123def456]',
      '[bx:pr-merge-ready:tok111222333]',
    ].join('\n');
    expect(scanPhaseSignals(text)).toEqual([
      { kind: 'pr-fixed', token: 'xyz789def' },
      { kind: 'pr-created', prNumber: 7, actorB64: 'Nzc', token: 'fff111222333' },
      { kind: 'spec-done', prNumber: 42, actorB64: 'Nzc', token: 'abc123def456' },
      { kind: 'pr-merge-ready', token: 'tok111222333' },
    ]);
  });

  it('rejects placeholders, incomplete delivery signals, and retired kinds', () => {
    expect(scanPhaseSignals('[bx:spec-done:<token>]')).toEqual([]);
    expect(scanPhaseSignals('[bx:pr-created:<pr_number>:<actor_b64>:<token>]')).toEqual([]);
    expect(scanPhaseSignals('[bx:spec-done:abcdef123456]')).toEqual([]);
    expect(scanPhaseSignals('[bx:pr-created:42:abcdef123456]')).toEqual([]);
    for (const kind of [
      'code-done', 'code-reviewed', 'code-fixed', 'code-ready', 'spec-reviewed', 'spec-fixed',
    ]) {
      expect(scanPhaseSignals(`[bx:${kind}:abcdef123456]`)).toEqual([]);
    }
  });

  it('fuzzy-matches a delivery signal split across lines', () => {
    const wrapped = '[bx:spec-done:4\n  2:Nz\n  c:abc12\n  3def456]';
    expect(scanPhaseSignals(wrapped)).toEqual([
      { kind: 'spec-done', prNumber: 42, actorB64: 'Nzc', token: 'abc123def456' },
    ]);
  });

  it('keeps the last segment as token when actor and token share the charset', () => {
    expect(scanPhaseSignals('[bx:pr-created:42:abcdef123456:bbbbbb123456]')).toEqual([
      { kind: 'pr-created', prNumber: 42, actorB64: 'abcdef123456', token: 'bbbbbb123456' },
    ]);
  });

  it('drops a pr-created whose actor segment carries out-of-charset bytes', () => {
    expect(scanPhaseSignals('[bx:pr-created:42:has.dot:abcdef123456]')).toEqual([]);
  });

  it('decodes base64url actor ids back to the exact byte string', () => {
    expect(decodeSignalActorId('Nzc')).toBe('77');
    expect(decodeSignalActorId('MDExMDU1NTQ4')).toBe('011055548');
    expect(decodeSignalActorId(Buffer.from('bot[7]:x', 'utf8').toString('base64url'))).toBe('bot[7]:x');
    expect(decodeSignalActorId(Buffer.from('机器人-77', 'utf8').toString('base64url'))).toBe('机器人-77');
  });

  it('rejects malformed, oversized, and control-character actor payloads', () => {
    expect(decodeSignalActorId('')).toBeUndefined();
    expect(decodeSignalActorId('abcde')).toBeUndefined();
    expect(decodeSignalActorId('Nzc=')).toBeUndefined();
    expect(decodeSignalActorId(Buffer.from('x'.repeat(129), 'utf8').toString('base64url'))).toBeUndefined();
    expect(decodeSignalActorId(Buffer.from('x'.repeat(128), 'utf8').toString('base64url'))).toBe('x'.repeat(128));
    expect(decodeSignalActorId(Buffer.from('a\tb', 'utf8').toString('base64url'))).toBeUndefined();
    expect(decodeSignalActorId(Buffer.from([0x61, 0xff, 0x62]).toString('base64url'))).toBeUndefined();
  });

  it('matches a marker the terminal shows through SGR colouring', () => {
    const colored = `\x1b[32m[bx:spec-done:42:Nzc:tokABCDEF]\x1b[0m`;
    expect(scanPhaseSignals(visibleText(colored))).toEqual([
      { kind: 'spec-done', prNumber: 42, actorB64: 'Nzc', token: 'tokABCDEF' },
    ]);
  });

  it('ignores unknown kinds and malformed tokens', () => {
    expect(scanPhaseSignals('[bx:unknown-kind:abc123]')).toEqual([]);
    expect(scanPhaseSignals('[bx:spec-done:42:Nzc:abc]')).toEqual([]);
    expect(scanPhaseSignals('[bx:spec-done:42:Nzc:tok]extra]')).toEqual([]);
    expect(scanPhaseSignals('[bx:pr-created:abc:Nzc:tok123abc]')).toEqual([]);
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
    const text = '[bx:spec-done:7:Nzc:tokSpec01234]\nlater\n[bx:pr-created:42:Nzc:tokPR0123456]';
    expect(scanPhaseSignals(text)).toEqual([
      { kind: 'spec-done', prNumber: 7, actorB64: 'Nzc', token: 'tokSpec01234' },
      { kind: 'pr-created', prNumber: 42, actorB64: 'Nzc', token: 'tokPR0123456' },
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

describe('root-done signal', () => {
  it('survives ANSI noise and TUI soft-wrap whitespace', () => {
    expect(scanRootDoneSignals(visibleText('\x1b[32m[bx:root-\ndone:0123456789ab\n  cdef0123456789abcdef]\x1b[0m'))).toEqual([
      '0123456789abcdef0123456789abcdef',
    ]);
  });

  it('ignores templates, short tokens, and extra segments', () => {
    expect(scanRootDoneSignals('[bx:root-done:<attemptToken>]')).toEqual([]);
    expect(scanRootDoneSignals('[bx:root-done:short]')).toEqual([]);
    expect(scanRootDoneSignals('[bx:root-done:0123456789abcdef:extra]')).toEqual([]);
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
