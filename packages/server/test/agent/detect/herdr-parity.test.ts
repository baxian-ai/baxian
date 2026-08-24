import { describe, it, expect } from 'vitest';
import { classifyScreen } from '../../../src/agent/detect/classify.js';
import { evaluateManifest, type AgentManifest } from '../../../src/agent/detect/manifest.js';
import { extractRegion } from '../../../src/agent/detect/region.js';

// 输入与断言逐条取自 herdr@1c76079f 的 src/detect/manifest/tests.rs,不做改写。
// 状态名映射:herdr Blocked→pending、Unknown→unknown。

describe('herdr parity: claude OSC rules', () => {
  it('braille prefix title is working', () => {
    const d = classifyScreen('claude-code', '', '⠂ project', '');
    expect(d.state).toBe('working');
    expect(d.matchedRuleId).toBe('osc_title_working');
    expect(d.visibleWorking).toBe(true);
  });

  it.each(['◐', '◓', '◑', '◒'])('half-circle frame %s title is working', (frame) => {
    const d = classifyScreen('claude-code', '', `${frame} Initial conversation with Claude`, '');
    expect(d.state).toBe('working');
    expect(d.matchedRuleId).toBe('osc_title_working');
    expect(d.visibleWorking).toBe(true);
  });

  it('static ✳ prefix title is idle', () => {
    const d = classifyScreen('claude-code', '', '✳ Claude Code', '');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBe('osc_title_idle');
    expect(d.visibleIdle).toBe(true);
  });

  it('progress 4;3 alone does not force working', () => {
    const d = classifyScreen('claude-code', '', '', '4;3;');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBeUndefined();
    expect(d.visibleWorking).toBe(false);
  });

  it('blocker screen outranks stale progress 4;3', () => {
    const screen = '──────────\n  1. Yes\n  2. No\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
    const d = classifyScreen('claude-code', screen, '✳ Task title', '4;3;');
    expect(d.state).toBe('pending');
    expect(d.visibleBlocker).toBe(true);
  });

  it('progress 4;0 is idle', () => {
    const d = classifyScreen('claude-code', '', '', '4;0;');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBe('osc_progress_idle');
  });

  it('blocker screen outranks an idle OSC title', () => {
    const screen = 'do you want to proceed?\n'
      + 'bash command: rm -rf /tmp/test\n'
      + '❯ 1. Yes\n   2. No\n\n'
      + 'Esc to cancel · Tab to amend · ctrl+e to explain\n';
    const d = classifyScreen('claude-code', screen, '✳ Claude Code', '');
    expect(d.state).toBe('pending');
    expect(d.visibleBlocker).toBe(true);
  });

  it('empty OSC and empty screen fall back to idle', () => {
    const d = classifyScreen('claude-code', '', '', '');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBeUndefined();
    expect(d.visibleIdle).toBe(false);
  });
});

describe('herdr parity: codex OSC rules', () => {
  it('braille spinner title is working', () => {
    const d = classifyScreen('codex', '', '⠋ llm-proxy', '');
    expect(d.state).toBe('working');
    expect(d.matchedRuleId).toBe('osc_title_working');
    expect(d.visibleWorking).toBe(true);
  });

  it('Action Required title is blocked', () => {
    const d = classifyScreen('codex', '', '[ . ] Action Required | llm-proxy', '');
    expect(d.state).toBe('pending');
    expect(d.matchedRuleId).toBe('osc_title_blocked');
    expect(d.visibleBlocker).toBe(true);
  });

  it('plain title is idle', () => {
    const d = classifyScreen('codex', '', 'llm-proxy', '');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBe('osc_title_idle');
    expect(d.visibleIdle).toBe(true);
  });

  it('trust directory requires the live top region', () => {
    const screen = '> You are in C:\\Users\\user\\project\n\n'
      + 'Do you trust the contents of this\n'
      + 'directory? Working with untrusted\n'
      + 'contents comes with higher risk of\n'
      + 'prompt injection. Trusting the\n'
      + 'directory allows project-local config,\n'
      + 'hooks, and exec policies to load.\n\n'
      + '› 1. Yes, continue\n'
      + '  2. No, quit\n\n'
      + 'Press enter to continue\n';
    const live = classifyScreen('codex', screen, 'project', '');
    expect(live.state).toBe('pending');
    expect(live.matchedRuleId).toBe('trust_directory');
    expect(live.visibleBlocker).toBe(true);

    const transcript = '› > You are in C:\\Users\\user\\project\n\n'
      + 'Do you trust the contents of this\n'
      + 'directory? Working with untrusted contents comes with higher risk.\n';
    const scrolled = classifyScreen('codex', transcript, 'project', '');
    expect(scrolled.state).toBe('idle');
    expect(scrolled.matchedRuleId).not.toBe('trust_directory');
    expect(scrolled.visibleBlocker).toBe(false);
  });

  it('background terminal screen does not override an idle OSC title', () => {
    const screen = 'background terminal running · /ps to view · /stop to close\n';
    const d = classifyScreen('codex', screen, 'llm-proxy', '');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBe('osc_title_idle');
    expect(d.visibleIdle).toBe(true);
  });

  it('screen working fallback handles a static OSC title', () => {
    const screen = '• I’ll run it and wait for completion.\n\n'
      + '◦ Working (1m 16s • esc to interrupt) · 1 background…\n\n'
      + '› Use /skills to list available skills\n\n'
      + 'gpt-5.6-sol default · /work\n';
    const d = classifyScreen('codex', screen, 'project', '');
    expect(d.state).toBe('working');
    expect(d.matchedRuleId).toBe('screen_working_fallback');
    expect(d.visibleWorking).toBe(true);
  });

  it('OSC working stays preferred over the screen fallback', () => {
    const screen = '• Working (4s • esc to interrupt)\n\n'
      + '› Use /skills to list available skills\n\n'
      + 'gpt-5.6-sol default · /work\n';
    const d = classifyScreen('codex', screen, '⠸ project', '');
    expect(d.state).toBe('working');
    expect(d.matchedRuleId).toBe('osc_title_working');
    expect(d.visibleWorking).toBe(true);
  });

  it('screen blocker outranks the working fallback', () => {
    const screen = '• Working (4s • esc to interrupt)\n'
      + '› 1. Yes, proceed\n'
      + 'Press enter to confirm or esc to cancel\n';
    const d = classifyScreen('codex', screen, 'project', '');
    expect(d.state).toBe('pending');
    expect(d.matchedRuleId).toBe('live_strong_blocker');
    expect(d.visibleBlocker).toBe(true);
    expect(d.visibleWorking).toBe(false);
  });

  it('weak blocker outranks the working fallback', () => {
    const screen = '• Working (4s • esc to interrupt)\n'
      + 'do you want to continue? [y/n]\n'
      + '› Use /skills to list available skills\n';
    const d = classifyScreen('codex', screen, 'project', '');
    expect(d.state).toBe('pending');
    expect(d.matchedRuleId).toBe('weak_blocker');
    expect(d.visibleWorking).toBe(false);
  });

  it('transcript viewer outranks the working fallback', () => {
    const screen = '• Working (4s • esc to interrupt)\n'
      + '› transcript\n'
      + '↑/↓ to scroll · pgup/pgdn to move · home/end to jump · q to quit · esc to edit prev\n';
    const d = classifyScreen('codex', screen, 'project', '');
    expect(d.state).toBe('unknown');
    expect(d.matchedRuleId).toBe('transcript_viewer');
    expect(d.skipStateUpdate).toBe(true);
    expect(d.visibleWorking).toBe(false);
  });

  it.each([
    '◦ Working (1m 16s • esc to interrupt)\n■ Conversation interrupted\n› Use /skills to list available skills\ngpt-5.6-sol default · /work\n',
    '› Explain the text ◦ Working (1m 16s • esc to interrupt)\ngpt-5.6-sol default · /work\n',
    '  ◦ Working (1m 16s • esc to interrupt)\n› Use /skills to list available skills\ngpt-5.6-sol default · /work\n',
  ])('screen working fallback ignores stale and prompt text (%#)', (screen) => {
    const d = classifyScreen('codex', screen, 'project', '');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBe('osc_title_idle');
    expect(d.visibleIdle).toBe(true);
    expect(d.visibleWorking).toBe(false);
  });

  it('screen working fallback ignores an interrupted short terminal', () => {
    const screen = '◦ Working (1m 16s • esc to interrupt)\n'
      + '■ Conversation interrupted\n'
      + '›\n';
    const d = classifyScreen('codex', screen, 'project', '');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBe('osc_title_idle');
    expect(d.visibleIdle).toBe(true);
    expect(d.visibleWorking).toBe(false);
  });

  it('OSC working beats a weak blocker screen', () => {
    const d = classifyScreen('codex', 'do you want to continue? [y/n]\n', '⠋ llm-proxy', '');
    expect(d.state).toBe('working');
    expect(d.matchedRuleId).toBe('osc_title_working');
  });
});

describe('herdr parity: region byte semantics', () => {
  const screen = (content: string): { screen: string; oscTitle: string; oscProgress: string } =>
    ({ screen: content, oscTitle: '', oscProgress: '' });

  it('bottom_non_empty_lines uses the bottom occurrence for repeated text', () => {
    const content = 'marker\nold\n\nmiddle\nmarker\nnew\n';
    expect(extractRegion(screen(content), 'bottom_non_empty_lines(2)')).toBe('marker\nnew\n');
  });

  it('top_non_empty_lines uses the top occurrence for repeated text', () => {
    const content = '\nmarker\nold\n\nmiddle\nmarker\nnew\n';
    expect(extractRegion(screen(content), 'top_non_empty_lines(2)')).toBe('\nmarker\nold\n');
  });
});

describe('herdr parity: rule gate / priority semantics', () => {
  const manifest: AgentManifest = {
    id: 'codex',
    rules: [
      { id: 'low_contains', state: 'idle', priority: 1, region: 'whole_recent', contains: ['match'] },
      {
        id: 'high_nested_gates',
        state: 'working',
        priority: 10,
        region: 'whole_recent',
        contains: ['match'],
        all: [{ any: [{ regex: ['w[io]n'] }, { contains: ['fallback'] }] }],
        not: [{ contains: ['blocked'] }],
      },
      { id: 'line_regex', state: 'pending', priority: 20, region: 'whole_recent', lineRegex: ['^exact line$'] },
    ],
  };
  const evaluate = (text: string): ReturnType<typeof evaluateManifest> =>
    evaluateManifest(manifest, { screen: text, oscTitle: '', oscProgress: '' });

  it('the higher-priority nested-gate rule wins', () => {
    const d = evaluate('match win');
    expect(d.state).toBe('working');
    expect(d.matchedRuleId).toBe('high_nested_gates');
  });

  it('a not-gate hit falls back to the lower-priority rule', () => {
    const d = evaluate('match win blocked');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBe('low_contains');
  });

  it('line_regex matches a single line inside the region', () => {
    const d = evaluate('before\nexact line\nafter');
    expect(d.state).toBe('pending');
    expect(d.matchedRuleId).toBe('line_regex');
  });

  it('a known agent with no rule match defaults to the idle fallback', () => {
    const d = classifyScreen('codex', 'ordinary prompt text', '', '');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBeUndefined();
    expect(d.visibleIdle).toBe(false);
  });
});
