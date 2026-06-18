import { describe, it, expect } from 'vitest';
import { evaluateGate, type Gate } from '../../../src/agent/detect/gate.js';

describe('evaluateGate', () => {
  it('matches contains (case-insensitive)', () => {
    const gate: Gate = { contains: ['do you want to proceed'] };
    expect(evaluateGate(gate, 'Do you want to proceed? [y/n]')).toBe(true);
    expect(evaluateGate(gate, 'Working on task...')).toBe(false);
  });

  it('requires ALL contains entries to match', () => {
    const gate: Gate = { contains: ['proceed', 'esc to cancel'] };
    expect(evaluateGate(gate, 'Do you want to proceed? Esc to cancel')).toBe(true);
    expect(evaluateGate(gate, 'Do you want to proceed?')).toBe(false);
  });

  it('matches regex against whole text', () => {
    const gate: Gate = { regex: ['^[\\u2800-\\u28FF] '] };
    expect(evaluateGate(gate, '⠁ Working...')).toBe(true);
    expect(evaluateGate(gate, 'idle prompt')).toBe(false);
  });

  it('matches lineRegex per line', () => {
    const gate: Gate = { lineRegex: ['^\\s*[❯>]\\s*$'] };
    expect(evaluateGate(gate, 'some output\n❯ \nmore')).toBe(true);
    expect(evaluateGate(gate, 'some output\n❯ command\nmore')).toBe(false);
  });

  it('evaluates nested all (all must match)', () => {
    const gate: Gate = {
      all: [
        { contains: ['yes'] },
        { contains: ['no'] },
      ],
    };
    expect(evaluateGate(gate, '1. Yes  2. No')).toBe(true);
    expect(evaluateGate(gate, '1. Yes')).toBe(false);
  });

  it('evaluates nested any (at least one must match)', () => {
    const gate: Gate = {
      any: [
        { contains: ['bash command'] },
        { contains: ['tab to amend'] },
      ],
    };
    expect(evaluateGate(gate, 'Run this bash command?')).toBe(true);
    expect(evaluateGate(gate, 'Nothing here')).toBe(false);
  });

  it('evaluates not (none must match)', () => {
    const gate: Gate = {
      contains: ['proceed'],
      not: [{ contains: ['cancelled'] }],
    };
    expect(evaluateGate(gate, 'Do you want to proceed?')).toBe(true);
    expect(evaluateGate(gate, 'Do you want to proceed? (cancelled)')).toBe(false);
  });

  it('empty gate (no matchers) returns false', () => {
    expect(evaluateGate({}, 'anything')).toBe(false);
  });

  it('not-only gate matches when negated content is absent', () => {
    const gate: Gate = { not: [{ contains: ['cancelled'] }] };
    expect(evaluateGate(gate, 'Do you want to proceed?')).toBe(true);
    expect(evaluateGate(gate, 'Operation cancelled')).toBe(false);
  });

  it('notAfter suppresses when negative appears after positive match', () => {
    const gate: Gate = {
      contains: ['allow command?'],
      notAfter: [{ lineRegex: ['^Working \\('] }],
    };
    expect(evaluateGate(gate, 'Allow command?\nrm -rf test\nWorking (3s)')).toBe(false);
  });

  it('notAfter does NOT suppress when negative appears before positive match', () => {
    const gate: Gate = {
      contains: ['allow command?'],
      notAfter: [{ lineRegex: ['^Working \\('] }],
    };
    expect(evaluateGate(gate, 'Working (3s)\nAllow command?\nrm -rf test')).toBe(true);
  });

  it('notAfter does not fire when positive match is on last line', () => {
    const gate: Gate = {
      contains: ['allow command?'],
      notAfter: [{ contains: ['anything'] }],
    };
    expect(evaluateGate(gate, 'some output\nAllow command?')).toBe(true);
  });

  it('notAfter uses last positive match line as anchor', () => {
    const gate: Gate = {
      any: [
        { contains: ['press enter to confirm'] },
        { contains: ['allow command?'] },
      ],
      notAfter: [{ lineRegex: ['^Working \\('] }],
    };
    const text = 'Allow command?\nPress Enter to confirm\nWorking (3s)';
    expect(evaluateGate(gate, text)).toBe(false);
    const textReversed = 'Working (3s)\nAllow command?\nPress Enter to confirm';
    expect(evaluateGate(gate, textReversed)).toBe(true);
  });

  it('combines contains + regex + nested gates', () => {
    const gate: Gate = {
      contains: ['do you want to proceed?'],
      any: [
        { contains: ['bash command'] },
        { contains: ['tab to amend'] },
      ],
      all: [
        { any: [
          { lineRegex: ['^\\s*❯?\\s*yes\\b'] },
          { lineRegex: ['^\\s*1\\.\\s*yes\\b'] },
        ]},
      ],
    };
    const screen = 'Do you want to proceed?\nbash command\n❯ yes\n2. no';
    expect(evaluateGate(gate, screen)).toBe(true);
  });
});
