import { describe, it, expect } from 'vitest';
import { extractRegion, type DetectionInput } from '../../../src/agent/detect/region.js';

function input(screen: string, oscTitle = ''): DetectionInput {
  return { screen, oscTitle };
}

describe('extractRegion', () => {
  it('whole returns full screen', () => {
    expect(extractRegion(input('line1\nline2\nline3'), 'whole')).toBe('line1\nline2\nline3');
  });

  it('tail(N) returns bottom N lines', () => {
    const screen = 'a\nb\nc\nd\ne';
    expect(extractRegion(input(screen), 'tail(3)')).toBe('c\nd\ne');
  });

  it('tail(N) returns all if fewer than N lines', () => {
    expect(extractRegion(input('a\nb'), 'tail(5)')).toBe('a\nb');
  });

  it('tailNonEmpty(N) skips trailing blank lines', () => {
    const screen = 'a\nb\n  \nc\n\n  \n';
    expect(extractRegion(input(screen), 'tailNonEmpty(2)')).toBe('b\n  \nc');
  });

  it('oscTitle returns the OSC title string', () => {
    expect(extractRegion(input('screen', '⠋ Working'), 'oscTitle')).toBe('⠋ Working');
  });

  it('afterLastHorizontalRule returns content after last ─── line', () => {
    const screen = 'header\n───────────\nbody1\n───────────\nbody2\nfooter';
    expect(extractRegion(input(screen), 'afterLastHorizontalRule')).toBe('body2\nfooter');
  });

  it('afterLastHorizontalRule returns full screen if no rule found', () => {
    expect(extractRegion(input('no rules here'), 'afterLastHorizontalRule')).toBe('no rules here');
  });

  it('promptBoxBody returns content between last two horizontal rules', () => {
    const screen = 'top\n────\nprompt line 1\nprompt line 2\n────\nbelow';
    expect(extractRegion(input(screen), 'promptBoxBody')).toBe('prompt line 1\nprompt line 2');
  });

  it('promptBoxBody returns empty if fewer than 2 rules', () => {
    expect(extractRegion(input('one\n────\ntwo'), 'promptBoxBody')).toBe('');
  });

  it('afterLastPromptMarker returns content after last bare › line', () => {
    const screen = '›\noutput\n›\nresponse here';
    expect(extractRegion(input(screen), 'afterLastPromptMarker')).toBe('response here');
  });

  it('afterLastPromptMarker returns full screen if no marker', () => {
    expect(extractRegion(input('no markers'), 'afterLastPromptMarker')).toBe('no markers');
  });

  it('afterLastPromptMarker matches indented bare › (Codex indents the prompt marker)', () => {
    const screen = '  › previous prompt\noutput\n  ›\nresponse';
    expect(extractRegion(input(screen), 'afterLastPromptMarker')).toBe('response');
  });

  it('afterLastPromptMarker skips numbered selections (› 1. Yes)', () => {
    const screen = '›\nAllow command?\n› 1. Yes\n  2. No';
    expect(extractRegion(input(screen), 'afterLastPromptMarker')).toBe('Allow command?\n› 1. Yes\n  2. No');
  });

  it('tailNonEmpty counts only non-empty lines toward N', () => {
    const screen = 'line1\nline2\n\nline3\n\nline4\n';
    const result = extractRegion(input(screen), 'tailNonEmpty(3)');
    expect(result).toContain('line2');
    expect(result).toContain('line3');
    expect(result).toContain('line4');
    expect(result).not.toContain('line1');
  });

  it('afterLastPromptMarker recognizes Codex → composer as boundary when at tail', () => {
    const screen = '› old prompt\nesc to interrupt\n→ baxian git:(main)';
    expect(extractRegion(input(screen), 'afterLastPromptMarker')).toBe('');
  });

  it('afterLastPromptMarker skips → composer when content follows below', () => {
    const screen = '› old prompt\nesc to interrupt\n→ baxian git:(main)\nidle output';
    expect(extractRegion(input(screen), 'afterLastPromptMarker')).toBe('› old prompt\nesc to interrupt\n→ baxian git:(main)\nidle output');
  });

  it('afterLastPromptMarker rejects non-ready arrow lines (→ Fetching data)', () => {
    const screen = '›\nWorking (3s)\n→ Fetching data from server\nesc to interrupt';
    expect(extractRegion(input(screen), 'afterLastPromptMarker')).toBe('Working (3s)\n→ Fetching data from server\nesc to interrupt');
  });

  it('afterLastPromptMarker accepts › with text when ready footer is at tail', () => {
    const screen = '› old task\n\n  baxian · idle';
    expect(extractRegion(input(screen), 'afterLastPromptMarker')).toBe('\n  baxian · idle');
  });

  it('afterLastPromptMarker rejects › with ready footer when content follows below', () => {
    const screen = '› old task\n\n  baxian · idle\nmore output';
    expect(extractRegion(input(screen), 'afterLastPromptMarker')).toBe('› old task\n\n  baxian · idle\nmore output');
  });

  it('afterLastPromptMarker ignores › with text when no ready footer follows', () => {
    const screen = '› Fetching data\nWorking (3s)\nesc to interrupt';
    expect(extractRegion(input(screen), 'afterLastPromptMarker')).toBe('› Fetching data\nWorking (3s)\nesc to interrupt');
  });

  it('unknown region returns empty string', () => {
    expect(extractRegion(input('x'), 'bogus')).toBe('');
  });
});
