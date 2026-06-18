import { describe, it, expect } from 'vitest';
import { evaluateManifest, type AgentManifest } from '../../../src/agent/detect/manifest.js';
import type { DetectionInput } from '../../../src/agent/detect/region.js';
import claudeManifest from '../../../src/agent/detect/manifests/claude-code.json' with { type: 'json' };

const manifest = claudeManifest as AgentManifest;

function input(screen: string, oscTitle = ''): DetectionInput {
  return { screen, oscTitle };
}

describe('claude-code manifest', () => {
  it('detects OSC braille spinner as working', () => {
    const result = evaluateManifest(manifest, input('', '⠁ Reading file'));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('osc_title_working');
  });

  it('detects OSC ✳ as idle', () => {
    const result = evaluateManifest(manifest, input('', '✳ ~/code/project'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('osc_title_idle');
  });

  it('detects bash permission prompt as blocked', () => {
    const screen = [
      '  herdr wants to run this bash command:',
      '    rm -rf /tmp/test',
      '',
      '  Do you want to proceed?',
      '  Tab to amend',
      '  ❯ Yes',
      '  2. No',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.visibleBlocker).toBe(true);
  });

  it('detects transcript viewer as skipStateUpdate', () => {
    const screen = [
      'Showing detailed transcript',
      '↑↓ scroll',
      '? for shortcuts',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('unknown');
    expect(result.matchedRuleId).toBe('transcript_viewer');
    expect(result.skipStateUpdate).toBe(true);
  });

  it('detects live blocked form (enter to select + navigation)', () => {
    const screen = [
      'some output',
      '────────────────',
      '  Enter to select · Esc to cancel',
      '  ↑/↓ to navigate',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('live_blocked_form');
  });

  it('detects dynamic workflow prompt as blocked', () => {
    const screen = 'Run a dynamic workflow?\nEsc to cancel';
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('dynamic_workflow_prompt');
  });

  it('detects live prompt box as idle (prompt between horizontal rules)', () => {
    const screen = [
      'output above',
      '────────────────',
      '  ❯ ',
      '────────────────',
      'status line',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('live_prompt_box');
    expect(result.visibleIdle).toBe(true);
  });

  it('model picker menu triggers skipStateUpdate', () => {
    const screen = [
      'Select model',
      'Enter to set as default',
      'Esc to cancel',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).toBe('model_picker_menu');
    expect(result.skipStateUpdate).toBe(true);
  });

  it('detects active spinner as working', () => {
    const screen = [
      'some previous output',
      '',
      '· Reading packages/server/src/agent/tmux.ts… (12s',
      '',
      '  esc to interrupt',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('working');
  });

  it('detects idle composer prompt', () => {
    const screen = [
      'previous output done.',
      '',
      '❯ ',
      '',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('idle_composer_prompt');
  });

  it('falls back to idle on unrecognized screen', () => {
    const result = evaluateManifest(manifest, input('Welcome to Claude Code'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBeUndefined();
  });

  it('screen idle overrides stale OSC working when no screen working signals', () => {
    const screen = '❯ \n';
    const result = evaluateManifest(manifest, input(screen, '⠁ Thinking'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('idle_composer_prompt');
  });

  it('spinner_working outranks live_prompt_box when OSC title is empty', () => {
    const screen = [
      '· Stewing… (5s',
      '────────────────',
      '❯ ',
      '────────────────',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, ''));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('spinner_working');
  });

  it('model_picker_menu outranks runtime_menu', () => {
    const screen = [
      'Select model',
      '  Claude Sonnet 4',
      '  Claude Opus 4',
      'Enter to set as default · Esc to cancel',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).toBe('model_picker_menu');
    expect(result.skipStateUpdate).toBe(true);
  });

  it('blocked wins over working spinner', () => {
    const screen = [
      '· Reading file… (3s',
      'Do you want to proceed?',
      'bash command',
      '❯ Yes',
      '2. No',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
  });

  it('legacy blocker "waiting for permission" sets visibleBlocker', () => {
    const screen = 'waiting for permission\nyes\n';
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('legacy_no_prompt_blocker');
    expect(result.visibleBlocker).toBe(true);
  });

  it('legacy blocker "tab to amend" sets visibleBlocker', () => {
    const screen = 'Run this command?\nTab to amend\n';
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('legacy_no_prompt_blocker');
    expect(result.visibleBlocker).toBe(true);
  });

  it('stale transcript text does not suppress runtime_menu footer', () => {
    const screen = [
      'Showing detailed transcript',
      'line a',
      'ctrl+o to toggle',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('transcript_viewer');
    expect(result.matchedRuleId).toBe('runtime_menu');
    expect(result.state).toBe('pending');
  });

  it('live_prompt_box does not match selection indicator ❯ Yes between rules', () => {
    const screen = [
      'Would you like to proceed?',
      '────────────────',
      '❯ Yes',
      '────────────────',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('live_prompt_box');
  });

  it('transcript viewer content with historical menu footer still matches as transcript', () => {
    const screen = [
      'Showing detailed transcript',
      'Earlier output from a previous menu:',
      'Enter to confirm · Esc to cancel',
      '',
      'ctrl+o to toggle',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).toBe('transcript_viewer');
    expect(result.skipStateUpdate).toBe(true);
  });

  it('legacy blocker is suppressed by bare > prompt', () => {
    const screen = 'waiting for permission\n>\n';
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('legacy_no_prompt_blocker');
  });

  it('legacy blocker is suppressed by esc to interrupt', () => {
    const screen = 'waiting for permission\nEsc to interrupt\n';
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('legacy_no_prompt_blocker');
  });

  it('stale bash permission prompt is suppressed by bare ❯ prompt', () => {
    const screen = [
      '  herdr wants to run this bash command:',
      '    rm -rf /tmp/test',
      '',
      '  Do you want to proceed?',
      '  Tab to amend',
      '  ❯ Yes',
      '  2. No',
      '────────────────',
      '  ❯ ',
      '────────────────',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('bash_permission_prompt');
  });

  it('stale bash permission prompt above horizontal rules loses to current spinner', () => {
    const screen = [
      '  herdr wants to run this bash command:',
      '    rm -rf /tmp/test',
      '',
      '  Do you want to proceed?',
      '  Tab to amend',
      '  ❯ Yes',
      '  2. No',
      '────────────────',
      '  ❯ continue',
      '────────────────',
      '· Running… (3s',
      '  esc to interrupt',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('bash_permission_prompt');
    expect(result.matchedRuleId).toBe('spinner_working');
  });

  it('stale esc-to-interrupt above idle prompt does not stay working', () => {
    const screen = [
      '────────────────',
      '  ❯ previous',
      '────────────────',
      '  esc to interrupt',
      '',
      '❯ ',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('esc_to_interrupt_working');
  });

  it('visible screen blocker overrides stale OSC working spinner', () => {
    const screen = [
      '  Do you want to proceed?',
      '  bash command',
      '  Tab to amend',
      '  ❯ Yes',
      '  2. No',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, '⠁ Reading file'));
    expect(result.state).toBe('pending');
    expect(result.visibleBlocker).toBe(true);
    expect(result.matchedRuleId).toBe('bash_permission_prompt');
  });

  it('screen idle overrides stale OSC working even with other output', () => {
    const screen = 'some output\n❯ \n';
    const result = evaluateManifest(manifest, input(screen, '⠁ Reading file'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('idle_composer_prompt');
  });

  it('stale dynamic workflow prompt suppressed by bare ❯ prompt', () => {
    const screen = [
      'Run a dynamic workflow?',
      'Esc to cancel',
      '',
      '────────────────',
      '  ❯ ',
      '────────────────',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('dynamic_workflow_prompt');
  });

  it('runtime_menu matches lowercase footer', () => {
    const screen = [
      'some output',
      'enter to confirm · esc to cancel',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('runtime_menu');
  });

  it('stale live_blocked_form suppressed by current spinner', () => {
    const screen = [
      'Enter to select · Esc to cancel',
      '↑/↓ to navigate',
      'agent continued',
      '· Running… (3s',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('live_blocked_form');
  });

  it('stale model_picker_menu loses to current spinner', () => {
    const screen = [
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      '· Running… (3s',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('model_picker_menu');
  });

  it('stale model_picker_menu loses to current runtime_menu', () => {
    const screen = [
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      'output',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('model_picker_menu');
  });

  it('generic_permission_prompt suppressed by bare ❯ prompt', () => {
    const screen = [
      'Do you want to proceed?',
      'Esc to cancel',
      '❯ 1. Yes',
      '2. No',
      '',
      '❯ ',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('generic_permission_prompt');
  });

  it('legacy_no_prompt_blocker scoped to after last horizontal rule', () => {
    const screen = [
      'waiting for permission',
      'yes',
      '────────────────',
      '  ❯ continue',
      '────────────────',
      '· Running… (3s',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('legacy_no_prompt_blocker');
  });

  it('spinner still matches when completed marker is above in tail(10)', () => {
    const screen = [
      '✻ Worked for 3s',
      '· Reading file… (1s',
      '  esc to interrupt',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('spinner_working');
  });

  it('stale model picker is suppressed by esc to interrupt', () => {
    const screen = [
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      '  esc to interrupt',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('model_picker_menu');
  });

  it('low-priority legacy blocker does not override OSC working', () => {
    const screen = 'waiting for permission\nyes\n';
    const result = evaluateManifest(manifest, input(screen, '⠁ Reading file'));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('osc_title_working');
  });

  it('old bare prompt above current blocker does not suppress (notAfter position-aware)', () => {
    const screen = [
      '❯ ',
      'some output',
      '  herdr wants to run this bash command:',
      '    rm -rf /tmp/test',
      '',
      '  Do you want to proceed?',
      '  Tab to amend',
      '  ❯ Yes',
      '  2. No',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('bash_permission_prompt');
  });

  it('old esc-to-interrupt above current legacy blocker does not suppress', () => {
    const screen = [
      'esc to interrupt',
      'some output',
      'waiting for permission',
      'yes',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('legacy_no_prompt_blocker');
  });

  it('stale runtime menu suppressed by current spinner (notAfter)', () => {
    const screen = [
      'Enter to confirm · Esc to cancel',
      '· Running… (3s',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('runtime_menu');
    expect(result.state).toBe('working');
  });

  it('completed spinner does not match when Worked-for follows (notAfter)', () => {
    const screen = [
      '· Running… (3s',
      '✻ Worked for 3s',
      '❯ ',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('spinner_working');
    expect(result.state).toBe('idle');
  });

  it('model picker skip overrides stale OSC working', () => {
    const screen = [
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, '⠁ Reading file'));
    expect(result.skipStateUpdate).toBe(true);
    expect(result.matchedRuleId).toBe('model_picker_menu');
  });

  it('stale generic permission prompt suppressed by current spinner', () => {
    const screen = [
      'Do you want to proceed?',
      'Esc to cancel',
      '❯ 1. Yes',
      '2. No',
      '· Running… (3s',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('generic_permission_prompt');
    expect(result.state).toBe('working');
  });

  it('screen blocker wins over stale model picker when OSC is working', () => {
    const screen = [
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      '────────────────',
      'Run a dynamic workflow?',
      'Esc to cancel',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, '⠁ Reading file'));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('dynamic_workflow_prompt');
  });

  it('legacy blocker ❯ in options does not pollute notAfter anchor', () => {
    const screen = [
      'Do you want to proceed?',
      '❯ Yes',
      '',
      '❯ ',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('legacy_no_prompt_blocker');
  });

  it('model picker survives stale "Do you want to proceed?" in scrollback', () => {
    const screen = [
      'Do you want to proceed?',
      'Tab to amend',
      '❯ Yes',
      '2. No',
      '────────────────',
      'Select model',
      '  Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).toBe('model_picker_menu');
    expect(result.skipStateUpdate).toBe(true);
  });

  it('stale runtime menu suppressed by current esc-to-interrupt', () => {
    const screen = [
      'Enter to confirm · Esc to cancel',
      '  esc to interrupt',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('runtime_menu');
  });

  it('stale bash permission prompt suppressed by current esc-to-interrupt', () => {
    const screen = [
      '─────────────────',
      'Do you want to proceed?',
      'Bash command: ls',
      '❯ Yes',
      '  2. No',
      'Tab to amend · Ctrl+E to explain',
      'esc to interrupt',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('bash_permission_prompt');
  });

  it('stale generic permission prompt suppressed by current esc-to-interrupt', () => {
    const screen = [
      '─────────────────',
      'Do you want to proceed? Esc to cancel',
      '  1. Yes',
      '  2. No',
      'esc to interrupt',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('generic_permission_prompt');
  });

  it('stale live_blocked_form suppressed by current esc-to-interrupt', () => {
    const screen = [
      '─────────────────',
      'Enter to select · Esc to cancel',
      'Tab/arrow keys to navigate',
      'esc to interrupt',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('live_blocked_form');
  });

  it('stale model picker suppressed by legacy blocker below', () => {
    const screen = [
      'Select model',
      'Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      '─────────────────',
      'Review your answers',
      '❯ Yes',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('model_picker_menu');
  });

  it('stale model picker suppressed by "would you like to" blocker below', () => {
    const screen = [
      'Select model',
      'Claude Sonnet 4',
      'Enter to set as default · Esc to cancel',
      '─────────────────',
      'Would you like to install this extension?',
      '❯ Yes',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('model_picker_menu');
  });

  it('bypass permissions banner recognized as visible idle', () => {
    const screen = [
      '❯ summarize previous task',
      '────────────────────────────────────────────────────────────────────────────────',
      '  Opus 4.7 [#################   ] 87%',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('idle_composer_prompt');
    expect(result.visibleIdle).toBe(true);
  });

  it('stale OSC working overridden by bypass permissions banner', () => {
    const screen = [
      '❯ summarize previous task',
      '────────────────────────────────────────────────────────────────────────────────',
      '  Opus 4.7 [#################   ] 87%',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, '⠁ Reading file'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('idle_composer_prompt');
  });

  it('bypass permissions in mid-output does NOT trigger idle', () => {
    const screen = [
      'still streaming',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      'more output',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, '⠁ Reading file'));
    expect(result.matchedRuleId).not.toBe('idle_composer_prompt');
  });

  it('bare ❯ in mid-tail does NOT trigger idle when output follows', () => {
    const screen = [
      'some output',
      '❯',
      'more streaming',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, '⠁ Working'));
    expect(result.matchedRuleId).not.toBe('idle_composer_prompt');
  });

  it('stale model picker suppressed by bypass permissions below', () => {
    const screen = [
      'Select model',
      'Enter to set as default · Esc to cancel',
      '─────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('model_picker_menu');
  });
});
