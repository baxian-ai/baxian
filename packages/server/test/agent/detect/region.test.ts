import { describe, it, expect } from 'vitest';
import { extractRegion, tailNonEmpty, type DetectionInput } from '../../../src/agent/detect/region.js';

function input(screen: string, oscTitle = ''): DetectionInput {
  return { screen, oscTitle };
}

describe('extractRegion', () => {
  it.each<[name: string, screen: string, region: string, expected: string]>([
    ['whole returns full screen', 'line1\nline2\nline3', 'whole', 'line1\nline2\nline3'],
    ['tail(N) returns bottom N lines', 'a\nb\nc\nd\ne', 'tail(3)', 'c\nd\ne'],
    ['tail(N) returns all if fewer than N lines', 'a\nb', 'tail(5)', 'a\nb'],
    ['tailNonEmpty(N) skips trailing blank lines', 'a\nb\n  \nc\n\n  \n', 'tailNonEmpty(2)', 'b\n  \nc'],
    ['oscTitle returns the OSC title string', 'screen', 'oscTitle', '⠋ Working'],
    ['afterLastHorizontalRule returns content after last ─── line', 'header\n───────────\nbody1\n───────────\nbody2\nfooter', 'afterLastHorizontalRule', 'body2\nfooter'],
    ['afterLastHorizontalRule returns full screen if no rule found', 'no rules here', 'afterLastHorizontalRule', 'no rules here'],
    ['promptBoxBody returns content between last two horizontal rules', 'top\n────\nprompt line 1\nprompt line 2\n────\nbelow', 'promptBoxBody', 'prompt line 1\nprompt line 2'],
    ['promptBoxBody returns empty if fewer than 2 rules', 'one\n────\ntwo', 'promptBoxBody', ''],
    ['afterLastPromptMarker returns content after last bare › line', '›\noutput\n›\nresponse here', 'afterLastPromptMarker', 'response here'],
    ['afterLastPromptMarker returns full screen if no marker', 'no markers', 'afterLastPromptMarker', 'no markers'],
    ['afterLastPromptMarker matches indented bare › (Codex indents the prompt marker)', '  › previous prompt\noutput\n  ›\nresponse', 'afterLastPromptMarker', 'response'],
    ['afterLastPromptMarker skips numbered selections (› 1. Yes)', '›\nAllow command?\n› 1. Yes\n  2. No', 'afterLastPromptMarker', 'Allow command?\n› 1. Yes\n  2. No'],
    ['afterLastPromptMarker recognizes Codex → composer as boundary when at tail', '› old prompt\nesc to interrupt\n→ baxian git:(main)', 'afterLastPromptMarker', ''],
    ['afterLastPromptMarker skips → composer when content follows below', '› old prompt\nesc to interrupt\n→ baxian git:(main)\nidle output', 'afterLastPromptMarker', '› old prompt\nesc to interrupt\n→ baxian git:(main)\nidle output'],
    ['afterLastPromptMarker rejects non-ready arrow lines (→ Fetching data)', '›\nWorking (3s)\n→ Fetching data from server\nesc to interrupt', 'afterLastPromptMarker', 'Working (3s)\n→ Fetching data from server\nesc to interrupt'],
    ['afterLastPromptMarker accepts › with text when ready footer is at tail', '› old task\n\n  baxian · idle', 'afterLastPromptMarker', '\n  baxian · idle'],
    ['afterLastPromptMarker rejects › with ready footer when content follows below', '› old task\n\n  baxian · idle\nmore output', 'afterLastPromptMarker', '› old task\n\n  baxian · idle\nmore output'],
    ['afterLastPromptMarker ignores › with text when no ready footer follows', '› Fetching data\nWorking (3s)\nesc to interrupt', 'afterLastPromptMarker', '› Fetching data\nWorking (3s)\nesc to interrupt'],
    ['unknown region returns empty string', 'x', 'bogus', ''],
  ])('%s', (_name, screen, region, expected) => {
    const osc = region === 'oscTitle' ? '⠋ Working' : '';
    expect(extractRegion(input(screen, osc), region)).toBe(expected);
  });

  it('tailNonEmpty counts only non-empty lines toward N', () => {
    const screen = 'line1\nline2\n\nline3\n\nline4\n';
    const result = extractRegion(input(screen), 'tailNonEmpty(3)');
    expect(result).toContain('line2');
    expect(result).toContain('line3');
    expect(result).toContain('line4');
    expect(result).not.toContain('line1');
  });

  it('tailNonEmpty(0) is an empty window, matching tail(0) semantics', () => {
    expect(extractRegion(input('a\nb\n'), 'tailNonEmpty(0)')).toBe('');
    expect(tailNonEmpty('a\nb\n', 0)).toBe('');
    expect(tailNonEmpty('a\nb\n', -1)).toBe('');
  });
});
