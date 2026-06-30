import { describe, it, expect } from 'vitest';
import { evaluateManifest, type AgentManifest } from '../../../src/agent/detect/manifest.js';
import type { DetectionInput } from '../../../src/agent/detect/region.js';
import claudeManifest from '../../../src/agent/detect/manifests/claude-code.json' with { type: 'json' };

const manifest = claudeManifest as AgentManifest;

function input(screen: string, oscTitle = ''): DetectionInput {
  return { screen, oscTitle };
}

interface Expectation {
  state?: string;
  rule?: string | undefined;
  notRule?: string;
  visibleBlocker?: boolean;
  visibleIdle?: boolean;
  skipStateUpdate?: boolean;
}

interface Case {
  name: string;
  lines: string[];
  osc?: string;
  expect: Expectation;
}

const BASH_PERMISSION_PROMPT = [
  '  herdr wants to run this bash command:',
  '    rm -rf /tmp/test',
  '',
  '  Do you want to proceed?',
  '  Tab to amend',
  '  ❯ Yes',
  '  2. No',
];

const cases: Case[] = [
  {
    name: 'detects OSC braille spinner as working',
    lines: [''],
    osc: '⠁ Reading file',
    expect: { state: 'working', rule: 'osc_title_working' },
  },
  {
    name: 'detects OSC ✳ as idle',
    lines: [''],
    osc: '✳ ~/code/project',
    expect: { state: 'idle', rule: 'osc_title_idle' },
  },
  {
    name: 'detects bash permission prompt as blocked',
    lines: [...BASH_PERMISSION_PROMPT],
    expect: { state: 'pending', visibleBlocker: true },
  },
  {
    name: 'detects transcript viewer as skipStateUpdate',
    lines: [
      'Showing detailed transcript',
      '↑↓ scroll',
      '? for shortcuts',
    ],
    expect: { state: 'unknown', rule: 'transcript_viewer', skipStateUpdate: true },
  },
  {
    name: 'detects live blocked form (enter to select + navigation)',
    lines: [
      'some output',
      '────────────────',
      '  Enter to select · Esc to cancel',
      '  ↑/↓ to navigate',
    ],
    expect: { state: 'pending', rule: 'live_blocked_form' },
  },
  {
    name: 'detects dynamic workflow prompt as blocked',
    lines: ['Run a dynamic workflow?', 'Esc to cancel'],
    expect: { state: 'pending', rule: 'dynamic_workflow_prompt' },
  },
  {
    name: 'detects live prompt box as idle (prompt between horizontal rules)',
    lines: [
      'output above',
      '────────────────',
      '  ❯ ',
      '────────────────',
      'status line',
    ],
    expect: { state: 'idle', rule: 'live_prompt_box', visibleIdle: true },
  },
  {
    name: 'model picker menu triggers skipStateUpdate',
    lines: [
      'Select model',
      'Enter to set as default',
      'Esc to cancel',
    ],
    expect: { rule: 'model_picker_menu', skipStateUpdate: true },
  },
  {
    name: 'detects active spinner as working',
    lines: [
      'some previous output',
      '',
      '· Reading packages/server/src/agent/tmux.ts… (12s',
      '',
      '  esc to interrupt',
    ],
    expect: { state: 'working' },
  },
  {
    name: 'detects idle composer prompt',
    lines: [
      'previous output done.',
      '',
      '❯ ',
      '',
    ],
    expect: { state: 'idle', rule: 'idle_composer_prompt' },
  },
  {
    name: 'falls back to idle on unrecognized screen',
    lines: ['Welcome to Claude Code'],
    expect: { state: 'idle', rule: undefined },
  },
  {
    name: 'screen idle overrides stale OSC working when no screen working signals',
    lines: ['❯ ', ''],
    osc: '⠁ Thinking',
    expect: { state: 'idle', rule: 'idle_composer_prompt' },
  },
  {
    name: 'spinner_working outranks live_prompt_box when OSC title is empty',
    lines: [
      '· Stewing… (5s',
      '────────────────',
      '❯ ',
      '────────────────',
    ],
    osc: '',
    expect: { state: 'working', rule: 'spinner_working' },
  },
  {
    name: 'model_picker_menu outranks runtime_menu',
    lines: [
      'Select model',
      '  Claude Sonnet 4',
      '  Claude Opus 4',
      'Enter to set as default · Esc to cancel',
    ],
    expect: { rule: 'model_picker_menu', skipStateUpdate: true },
  },
  {
    name: 'blocked wins over working spinner',
    lines: [
      '· Reading file… (3s',
      'Do you want to proceed?',
      'bash command',
      '❯ Yes',
      '2. No',
    ],
    expect: { state: 'pending' },
  },
  {
    name: 'legacy blocker "waiting for permission" sets visibleBlocker',
    lines: ['waiting for permission', 'yes', ''],
    expect: { state: 'pending', rule: 'legacy_no_prompt_blocker', visibleBlocker: true },
  },
  {
    name: 'legacy blocker "tab to amend" sets visibleBlocker',
    lines: ['Run this command?', 'Tab to amend', ''],
    expect: { state: 'pending', rule: 'legacy_no_prompt_blocker', visibleBlocker: true },
  },
  {
    name: 'stale transcript text does not suppress runtime_menu footer',
    lines: [
      'Showing detailed transcript',
      'line a',
      'ctrl+o to toggle',
      '',
      'Enter to confirm · Esc to cancel',
    ],
    expect: { notRule: 'transcript_viewer', rule: 'runtime_menu', state: 'pending' },
  },
  {
    name: 'live_prompt_box does not match selection indicator ❯ Yes between rules',
    lines: [
      'Would you like to proceed?',
      '────────────────',
      '❯ Yes',
      '────────────────',
    ],
    expect: { notRule: 'live_prompt_box' },
  },
  {
    name: 'transcript viewer content with historical menu footer still matches as transcript',
    lines: [
      'Showing detailed transcript',
      'Earlier output from a previous menu:',
      'Enter to confirm · Esc to cancel',
      '',
      'ctrl+o to toggle',
    ],
    expect: { rule: 'transcript_viewer', skipStateUpdate: true },
  },
  {
    name: 'legacy blocker is suppressed by bare > prompt',
    lines: ['waiting for permission', '>', ''],
    expect: { notRule: 'legacy_no_prompt_blocker' },
  },
  {
    name: 'legacy blocker is suppressed by esc to interrupt',
    lines: ['waiting for permission', 'Esc to interrupt', ''],
    expect: { notRule: 'legacy_no_prompt_blocker' },
  },
  {
    name: 'stale bash permission prompt is suppressed by bare ❯ prompt',
    lines: [
      ...BASH_PERMISSION_PROMPT,
      '────────────────',
      '  ❯ ',
      '────────────────',
    ],
    expect: { notRule: 'bash_permission_prompt' },
  },
  {
    name: 'stale bash permission prompt above horizontal rules loses to current spinner',
    lines: [
      ...BASH_PERMISSION_PROMPT,
      '────────────────',
      '  ❯ continue',
      '────────────────',
      '· Running… (3s',
      '  esc to interrupt',
    ],
    expect: { notRule: 'bash_permission_prompt', rule: 'spinner_working' },
  },
  {
    name: 'stale esc-to-interrupt above idle prompt does not stay working',
    lines: [
      '────────────────',
      '  ❯ previous',
      '────────────────',
      '  esc to interrupt',
      '',
      '❯ ',
    ],
    expect: { notRule: 'esc_to_interrupt_working' },
  },
  {
    name: 'visible screen blocker overrides stale OSC working spinner',
    lines: [
      '  Do you want to proceed?',
      '  bash command',
      '  Tab to amend',
      '  ❯ Yes',
      '  2. No',
    ],
    osc: '⠁ Reading file',
    expect: { state: 'pending', visibleBlocker: true, rule: 'bash_permission_prompt' },
  },
  {
    name: 'screen idle overrides stale OSC working even with other output',
    lines: ['some output', '❯ ', ''],
    osc: '⠁ Reading file',
    expect: { state: 'idle', rule: 'idle_composer_prompt' },
  },
  {
    name: 'stale dynamic workflow prompt suppressed by bare ❯ prompt',
    lines: [
      'Run a dynamic workflow?',
      'Esc to cancel',
      '',
      '────────────────',
      '  ❯ ',
      '────────────────',
    ],
    expect: { notRule: 'dynamic_workflow_prompt' },
  },
  {
    name: 'runtime_menu matches lowercase footer',
    lines: [
      'some output',
      'enter to confirm · esc to cancel',
    ],
    expect: { state: 'pending', rule: 'runtime_menu' },
  },
  {
    name: 'stale live_blocked_form suppressed by current spinner',
    lines: [
      'Enter to select · Esc to cancel',
      '↑/↓ to navigate',
      'agent continued',
      '· Running… (3s',
    ],
    expect: { notRule: 'live_blocked_form' },
  },
  {
    name: 'stale model_picker_menu loses to current spinner',
    lines: [
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      '· Running… (3s',
    ],
    expect: { notRule: 'model_picker_menu' },
  },
  {
    name: 'stale model_picker_menu loses to current runtime_menu',
    lines: [
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      'output',
      'Enter to confirm · Esc to cancel',
    ],
    expect: { notRule: 'model_picker_menu' },
  },
  {
    name: 'generic_permission_prompt suppressed by bare ❯ prompt',
    lines: [
      'Do you want to proceed?',
      'Esc to cancel',
      '❯ 1. Yes',
      '2. No',
      '',
      '❯ ',
    ],
    expect: { notRule: 'generic_permission_prompt' },
  },
  {
    name: 'legacy_no_prompt_blocker scoped to after last horizontal rule',
    lines: [
      'waiting for permission',
      'yes',
      '────────────────',
      '  ❯ continue',
      '────────────────',
      '· Running… (3s',
    ],
    expect: { notRule: 'legacy_no_prompt_blocker' },
  },
  {
    name: 'spinner still matches when completed marker is above in tail(10)',
    lines: [
      '✻ Worked for 3s',
      '· Reading file… (1s',
      '  esc to interrupt',
    ],
    expect: { state: 'working', rule: 'spinner_working' },
  },
  {
    name: 'stale model picker is suppressed by esc to interrupt',
    lines: [
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      '  esc to interrupt',
    ],
    expect: { notRule: 'model_picker_menu' },
  },
  {
    name: 'low-priority legacy blocker does not override OSC working',
    lines: ['waiting for permission', 'yes', ''],
    osc: '⠁ Reading file',
    expect: { state: 'working', rule: 'osc_title_working' },
  },
  {
    name: 'old bare prompt above current blocker does not suppress (notAfter position-aware)',
    lines: [
      '❯ ',
      'some output',
      ...BASH_PERMISSION_PROMPT,
    ],
    expect: { state: 'pending', rule: 'bash_permission_prompt' },
  },
  {
    name: 'old esc-to-interrupt above current legacy blocker does not suppress',
    lines: [
      'esc to interrupt',
      'some output',
      'waiting for permission',
      'yes',
    ],
    expect: { state: 'pending', rule: 'legacy_no_prompt_blocker' },
  },
  {
    name: 'stale runtime menu suppressed by current spinner (notAfter)',
    lines: [
      'Enter to confirm · Esc to cancel',
      '· Running… (3s',
    ],
    expect: { notRule: 'runtime_menu', state: 'working' },
  },
  {
    name: 'completed spinner does not match when Worked-for follows (notAfter)',
    lines: [
      '· Running… (3s',
      '✻ Worked for 3s',
      '❯ ',
    ],
    expect: { notRule: 'spinner_working', state: 'idle' },
  },
  {
    name: 'model picker skip overrides stale OSC working',
    lines: [
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
    ],
    osc: '⠁ Reading file',
    expect: { skipStateUpdate: true, rule: 'model_picker_menu' },
  },
  {
    name: 'stale generic permission prompt suppressed by current spinner',
    lines: [
      'Do you want to proceed?',
      'Esc to cancel',
      '❯ 1. Yes',
      '2. No',
      '· Running… (3s',
    ],
    expect: { notRule: 'generic_permission_prompt', state: 'working' },
  },
  {
    name: 'screen blocker wins over stale model picker when OSC is working',
    lines: [
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      '────────────────',
      'Run a dynamic workflow?',
      'Esc to cancel',
    ],
    osc: '⠁ Reading file',
    expect: { state: 'pending', rule: 'dynamic_workflow_prompt' },
  },
  {
    name: 'legacy blocker ❯ in options does not pollute notAfter anchor',
    lines: [
      'Do you want to proceed?',
      '❯ Yes',
      '',
      '❯ ',
    ],
    expect: { notRule: 'legacy_no_prompt_blocker' },
  },
  {
    name: 'model picker survives stale "Do you want to proceed?" in scrollback',
    lines: [
      'Do you want to proceed?',
      'Tab to amend',
      '❯ Yes',
      '2. No',
      '────────────────',
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
    ],
    expect: { rule: 'model_picker_menu', skipStateUpdate: true },
  },
  {
    name: 'stale runtime menu suppressed by current esc-to-interrupt',
    lines: [
      'Enter to confirm · Esc to cancel',
      '  esc to interrupt',
    ],
    expect: { notRule: 'runtime_menu' },
  },
  {
    name: 'stale bash permission prompt suppressed by current esc-to-interrupt',
    lines: [
      '─────────────────',
      'Do you want to proceed?',
      'Bash command: ls',
      '❯ Yes',
      '  2. No',
      'Tab to amend · Ctrl+E to explain',
      'esc to interrupt',
    ],
    expect: { notRule: 'bash_permission_prompt' },
  },
  {
    name: 'stale generic permission prompt suppressed by current esc-to-interrupt',
    lines: [
      '─────────────────',
      'Do you want to proceed? Esc to cancel',
      '  1. Yes',
      '  2. No',
      'esc to interrupt',
    ],
    expect: { notRule: 'generic_permission_prompt' },
  },
  {
    name: 'stale live_blocked_form suppressed by current esc-to-interrupt',
    lines: [
      '─────────────────',
      'Enter to select · Esc to cancel',
      'Tab/arrow keys to navigate',
      'esc to interrupt',
    ],
    expect: { notRule: 'live_blocked_form' },
  },
  {
    name: 'stale model picker suppressed by legacy blocker below',
    lines: [
      'Select model',
      'Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      '─────────────────',
      'Review your answers',
      '❯ Yes',
    ],
    expect: { notRule: 'model_picker_menu' },
  },
  {
    name: 'stale model picker suppressed by "would you like to" blocker below',
    lines: [
      'Select model',
      'Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      '─────────────────',
      'Would you like to install this extension?',
      '❯ Yes',
    ],
    expect: { notRule: 'model_picker_menu' },
  },
  {
    name: 'bypass permissions banner recognized as visible idle',
    lines: [
      '❯ summarize previous task',
      '────────────────────────────────────────────────────────────────────────────────',
      '  Opus 4.7 [#################   ] 87%',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ],
    expect: { state: 'idle', rule: 'idle_composer_prompt', visibleIdle: true },
  },
  {
    name: 'stale OSC working overridden by bypass permissions banner',
    lines: [
      '❯ summarize previous task',
      '────────────────────────────────────────────────────────────────────────────────',
      '  Opus 4.7 [#################   ] 87%',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ],
    osc: '⠁ Reading file',
    expect: { state: 'idle', rule: 'idle_composer_prompt' },
  },
  {
    name: 'bypass permissions in mid-output does NOT trigger idle',
    lines: [
      'still streaming',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      'more output',
    ],
    osc: '⠁ Reading file',
    expect: { notRule: 'idle_composer_prompt' },
  },
  {
    name: 'bare ❯ in mid-tail does NOT trigger idle when output follows',
    lines: [
      'some output',
      '❯',
      'more streaming',
    ],
    osc: '⠁ Working',
    expect: { notRule: 'idle_composer_prompt' },
  },
  {
    name: 'stale model picker suppressed by bypass permissions below',
    lines: [
      'Select model',
      'Enter to set as default · Esc to cancel',
      '─────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ],
    expect: { notRule: 'model_picker_menu' },
  },
  {
    name: 'stale live_blocked_form loses to current model picker (footer with Esc)',
    lines: [
      'Enter to select · Esc to cancel',
      '↑/↓ to navigate',
      '⏵⏵ bypass permissions on',
      'Select model',
      'Enter to set as default · Esc to cancel',
    ],
    expect: { notRule: 'live_blocked_form', rule: 'model_picker_menu', skipStateUpdate: true },
  },
  {
    name: 'stale live_blocked_form loses to current model picker (footer without Esc)',
    lines: [
      'Enter to select · Esc to cancel',
      '↑/↓ to navigate',
      '⏵⏵ bypass permissions on',
      'Select model',
      'Enter to set as default',
    ],
    expect: { notRule: 'live_blocked_form', rule: 'model_picker_menu', skipStateUpdate: true },
  },
  {
    name: 'stale dynamic_workflow_prompt loses to current model picker (footer with Esc)',
    lines: [
      'Run a dynamic workflow?',
      'Esc to cancel',
      '⏵⏵ bypass permissions on',
      'Select model',
      'Enter to set as default · Esc to cancel',
    ],
    expect: { notRule: 'dynamic_workflow_prompt', rule: 'model_picker_menu', skipStateUpdate: true },
  },
  {
    name: 'stale dynamic_workflow_prompt loses to current model picker (footer without Esc)',
    lines: [
      'Run a dynamic workflow?',
      'Esc to cancel',
      '⏵⏵ bypass permissions on',
      'Select model',
      'Enter to set as default',
    ],
    expect: { notRule: 'dynamic_workflow_prompt', rule: 'model_picker_menu', skipStateUpdate: true },
  },
  {
    name: 'detects live_blocked_form with split footer (Enter/Esc on separate lines)',
    lines: [
      'Enter to select',
      '↑/↓ to navigate',
      'Esc to cancel',
    ],
    expect: { rule: 'live_blocked_form', state: 'pending' },
  },
  {
    name: 'current live_blocked_form wins over stale model picker above',
    lines: [
      'Select model',
      'Enter to set as default · Esc to cancel',
      'Enter to select · Esc to cancel',
      '↑/↓ to navigate',
    ],
    expect: { rule: 'live_blocked_form', state: 'pending' },
  },
  {
    name: 'current dynamic_workflow_prompt wins over stale model picker above',
    lines: [
      'Select model',
      'Enter to set as default · Esc to cancel',
      'Run a dynamic workflow?',
      'Esc to cancel',
    ],
    expect: { rule: 'dynamic_workflow_prompt', state: 'pending' },
  },
  {
    name: 'stale live_blocked_form loses to current model picker (split footer)',
    lines: [
      'Enter to select · Esc to cancel',
      '↑/↓ to navigate',
      '⏵⏵ bypass permissions on',
      'Select model',
      'Enter to set as default',
      'Esc to cancel',
    ],
    expect: { rule: 'model_picker_menu', skipStateUpdate: true },
  },
  {
    name: 'stale dynamic_workflow_prompt loses to current model picker (split footer)',
    lines: [
      'Run a dynamic workflow?',
      'Esc to cancel',
      '⏵⏵ bypass permissions on',
      'Select model',
      'Enter to set as default',
      'Esc to cancel',
    ],
    expect: { rule: 'model_picker_menu', skipStateUpdate: true },
  },
  {
    name: 'stale model picker suppressed by mid-screen bypass with working output',
    lines: [
      'Select model',
      'Enter to set as default · Esc to cancel',
      '⏵⏵ bypass permissions on',
      'some working output',
      'more output',
    ],
    expect: { notRule: 'model_picker_menu' },
  },
];

describe('claude-code manifest', () => {
  it.each(cases)('$name', ({ lines, osc, expect: want }) => {
    const result = evaluateManifest(manifest, input(lines.join('\n'), osc ?? ''));
    if (want.state !== undefined) expect(result.state).toBe(want.state);
    if ('rule' in want) expect(result.matchedRuleId).toBe(want.rule);
    if (want.notRule !== undefined) expect(result.matchedRuleId).not.toBe(want.notRule);
    if (want.visibleBlocker !== undefined) expect(result.visibleBlocker).toBe(want.visibleBlocker);
    if (want.visibleIdle !== undefined) expect(result.visibleIdle).toBe(want.visibleIdle);
    if (want.skipStateUpdate !== undefined) expect(result.skipStateUpdate).toBe(want.skipStateUpdate);
  });

  it.each([
    { rule: 'bash_permission_prompt',    header: ['Do you want to proceed?', 'Bash command', '❯ Yes'],      state: 'pending', blocker: true },
    { rule: 'generic_permission_prompt', header: ['Do you want to proceed?', 'Esc to cancel', '❯ 1. Yes'], state: 'pending', blocker: true },
    { rule: 'runtime_menu',             header: ['Enter to confirm · Esc to cancel'],                       state: 'pending', blocker: true },
    { rule: 'esc_to_interrupt_working',  header: ['Esc to interrupt'],                                       state: 'working', blocker: false },
  ])('mid-screen bypass does NOT suppress $rule', ({ rule, header, state, blocker }) => {
    const screen = [...header, '  ⏵⏵ bypass permissions on (shift+tab to cycle)', 'more output'].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe(state);
    if (blocker) expect(result.visibleBlocker).toBe(true);
    expect(result.matchedRuleId).toBe(rule);
  });
});
