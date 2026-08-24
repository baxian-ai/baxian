import { describe, it, expect } from 'vitest';
import { extractRegion, type DetectionInput } from '../../../src/agent/detect/region.js';

function input(screen: string, oscTitle = '', oscProgress = ''): DetectionInput {
  return { screen, oscTitle, oscProgress };
}

describe('extractRegion (herdr region grammar)', () => {
  it.each<[name: string, screen: string, region: string, expected: string]>([
    ['whole_recent returns full screen', 'line1\nline2\nline3', 'whole_recent', 'line1\nline2\nline3'],
    ['osc_title returns the OSC title string', 'screen', 'osc_title', '⠋ Working'],
    ['osc_progress returns the OSC progress string', 'screen', 'osc_progress', '4;0;'],
    ['bottom_non_empty_lines(N) starts at the Nth-last non-empty line and keeps trailing blanks', 'a\nb\n  \nc\n\n  \n', 'bottom_non_empty_lines(2)', 'b\n  \nc\n\n  \n'],
    ['bottom_non_empty_lines(N) returns empty for an all-blank screen', '\n  \n\n', 'bottom_non_empty_lines(3)', ''],
    ['top_non_empty_lines(N) ends at the Nth non-empty line and keeps its newline', '\na\n\nb\nc\nd', 'top_non_empty_lines(2)', '\na\n\nb\n'],
    ['after_last_horizontal_rule returns content after last ─── line', 'header\n───────────\nbody1\n───────────\nbody2\nfooter', 'after_last_horizontal_rule', 'body2\nfooter'],
    ['after_last_horizontal_rule returns full screen if no rule found', 'no rules here', 'after_last_horizontal_rule', 'no rules here'],
    ['prompt_box_body returns content between last two horizontal rules', 'top\n────\nprompt line 1\nprompt line 2\n────\nbelow', 'prompt_box_body', 'prompt line 1\nprompt line 2\n'],
    ['prompt_box_body returns empty if fewer than 2 rules', 'one\n────\ntwo', 'prompt_box_body', ''],
    ['above_prompt_box returns content above the box top border', 'history\nmore\n────\n❯ \n────', 'above_prompt_box', 'history\nmore\n'],
    ['above_prompt_box returns full screen when no box', 'just output', 'above_prompt_box', 'just output'],
    ['last_non_empty_above_prompt_box returns the last non-empty line above the box', 'history\n✳ Waiting\n\n────\n❯ \n────', 'last_non_empty_above_prompt_box', '✳ Waiting'],
    ['after_last_prompt_marker returns content after last bare › line', '›\noutput\n›\nresponse here', 'after_last_prompt_marker', 'response here'],
    ['after_last_prompt_marker returns full screen if no marker', 'no markers', 'after_last_prompt_marker', 'no markers'],
    ['after_last_prompt_marker treats "› text" as a marker (herdr codex_prompt_line)', '› old prompt\nesc to interrupt\nmore', 'after_last_prompt_marker', 'esc to interrupt\nmore'],
    ['after_last_prompt_marker does NOT match an indented › (herdr matches raw line only)', '  ›\nresponse', 'after_last_prompt_marker', '  ›\nresponse'],
    ['unknown region returns empty string', 'x', 'bogus', ''],
    ['legacy region names are no longer part of the grammar', 'a\nb', 'tailNonEmpty(2)', ''],
  ])('%s', (_name, screen, region, expected) => {
    const osc = region === 'osc_title' ? '⠋ Working' : '';
    const progress = region === 'osc_progress' ? '4;0;' : '';
    expect(extractRegion(input(screen, osc, progress), region)).toBe(expected);
  });

  it('osc_progress defaults to empty when the input omits it (herdr: pass empty when unavailable)', () => {
    expect(extractRegion({ screen: 'x', oscTitle: '' }, 'osc_progress')).toBe('');
  });
});
