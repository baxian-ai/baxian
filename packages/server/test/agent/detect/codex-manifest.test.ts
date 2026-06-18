import { describe, it, expect } from 'vitest';
import { evaluateManifest, type AgentManifest } from '../../../src/agent/detect/manifest.js';
import type { DetectionInput } from '../../../src/agent/detect/region.js';
import codexManifest from '../../../src/agent/detect/manifests/codex.json' with { type: 'json' };

const manifest = codexManifest as AgentManifest;

function input(screen: string, oscTitle = ''): DetectionInput {
  return { screen, oscTitle };
}

describe('codex manifest', () => {
  it('detects OSC "Action Required" as blocked', () => {
    const result = evaluateManifest(manifest, input('', 'Action Required'));
    expect(result.state).toBe('pending');
    expect(result.visibleBlocker).toBe(true);
  });

  it('detects OSC braille spinner as working', () => {
    const result = evaluateManifest(manifest, input('', '⠁ codex'));
    expect(result.state).toBe('working');
  });

  it('detects transcript viewer as skipStateUpdate', () => {
    const screen = [
      '› prompt here',
      '↑/↓ to scroll · pgup/pgdn to page · home/end to jump · q to quit',
      'esc to edit prev',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).toBe('transcript_viewer');
    expect(result.skipStateUpdate).toBe(true);
  });

  it('detects strong blocker (allow command) after prompt marker', () => {
    const screen = [
      '› previous prompt',
      'Allow command?',
      'rm -rf /tmp/test',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('live_strong_blocker');
    expect(result.visibleBlocker).toBe(true);
  });

  it('blocker with numbered selection is not cut by prompt marker', () => {
    const screen = [
      '›',
      'Allow command?',
      '› 1. Yes',
      '  2. No',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('live_strong_blocker');
  });

  it('detects weak blocker [y/n] with visibleBlocker', () => {
    const screen = 'Continue? [y/n]';
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('weak_blocker');
    expect(result.visibleBlocker).toBe(true);
  });

  it('stale weak blocker does not override current working line', () => {
    const screen = [
      'Do you want to continue?',
      'Yes (y)',
      '',
      'Working (8s)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).toBe('working_line');
    expect(result.state).toBe('working');
  });

  it('OSC non-spinner non-action-required is idle', () => {
    const result = evaluateManifest(manifest, input('', 'codex ~/project'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('osc_title_idle');
  });

  it('stale weak blocker is suppressed by bare › prompt', () => {
    const screen = [
      'Do you want to continue?',
      'Yes (y)',
      '',
      '›',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('weak_blocker');
  });

  it('transcript viewer footer does not override active blocker when not on last line', () => {
    const screen = [
      '› prompt here',
      '↑/↓ to scroll · pgup/pgdn to page · home/end to jump · q to quit',
      'esc to edit prev',
      '',
      'Allow command?',
      'rm -rf /tmp/test',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('transcript_viewer');
    expect(result.matchedRuleId).toBe('live_strong_blocker');
  });

  it('falls back to idle on unrecognized screen', () => {
    const result = evaluateManifest(manifest, input('random output'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBeUndefined();
  });

  it('visible screen blocker overrides stale OSC working spinner', () => {
    const screen = [
      '› previous prompt',
      'Allow command?',
      'rm -rf /tmp/test',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, '⠁ codex'));
    expect(result.state).toBe('pending');
    expect(result.visibleBlocker).toBe(true);
    expect(result.matchedRuleId).toBe('live_strong_blocker');
  });

  it('stale strong blocker loses to current Working line', () => {
    const screen = [
      '› do something',
      'Allow command?',
      'rm -rf test',
      'Working (3s)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('live_strong_blocker');
    expect(result.matchedRuleId).toBe('working_line');
  });

  it('stale OSC Action Required overridden by visible idle prompt', () => {
    const screen = [
      '›',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, 'Action Required'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('codex_idle_prompt');
  });

  it('stale OSC Action Required overridden by visible Working line', () => {
    const screen = [
      '› do something',
      'Working (5s)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, 'Action Required'));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('working_line');
  });

  it('new blocker after old Working is not suppressed', () => {
    const screen = [
      '› do something',
      'Working (3s)',
      'Allow command?',
      'Press Enter to confirm or Esc to cancel',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('live_strong_blocker');
  });

  it('arrow composer → at tail excludes stale esc-to-interrupt', () => {
    const screen = [
      '› old prompt',
      'esc to interrupt',
      '→ baxian git:(main)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('esc_to_interrupt_working');
  });

  it('OSC pending prefers screen blocker over screen idle evidence', () => {
    const screen = [
      '›',
      'Allow command?',
      'Press Enter to confirm or Esc to cancel',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, 'Action Required'));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('live_strong_blocker');
  });

  it('arrow composer → recognized as visible idle', () => {
    const screen = [
      'some output',
      '→ baxian git:(main)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('codex_idle_prompt');
    expect(result.visibleIdle).toBe(true);
  });

  it('stale OSC Action Required overridden by arrow composer →', () => {
    const screen = [
      '→ baxian git:(main)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, 'Action Required'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('codex_idle_prompt');
  });

  it('stale weak blocker suppressed by arrow composer →', () => {
    const screen = [
      'Continue? [y/n]',
      '→ baxian git:(main)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('weak_blocker');
  });

  it('stale strong blocker suppressed by arrow composer →', () => {
    const screen = [
      '› old prompt',
      'Allow command?',
      'Press Enter to confirm or Esc to cancel',
      '→ baxian git:(main)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('live_strong_blocker');
  });

  it('arrow composer with user input is NOT idle (strict shape)', () => {
    const screen = [
      '→ run tests',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('codex_idle_prompt');
  });

  it('ready-anchor (› prompt + project footer) recognized as visible idle', () => {
    const screen = [
      '› do something',
      '',
      '  baxian · idle',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('codex_idle_prompt');
    expect(result.visibleIdle).toBe(true);
  });

  it('stale OSC Action Required overridden by ready-anchor', () => {
    const screen = [
      '› previous task',
      '',
      '  baxian · idle',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, 'Action Required'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('codex_idle_prompt');
  });

  it('stale weak blocker suppressed by ready-anchor below', () => {
    const screen = [
      'Continue? [y/n]',
      '› finished task',
      '',
      '  baxian · idle',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('weak_blocker');
  });

  it('stale strong blocker suppressed by ready-anchor below', () => {
    const screen = [
      '› old prompt',
      'Allow command?',
      'Press Enter to confirm or Esc to cancel',
      '› finished task',
      '',
      '  baxian · idle',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('live_strong_blocker');
  });

  it('ready-anchor in mid-screen does NOT trigger idle (must be at tail end)', () => {
    const screen = [
      '› old prompt',
      '',
      '  baxian · idle',
      'Working (3s)',
      'esc to interrupt',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('codex_idle_prompt');
  });

  it('arrow composer without git context still matches if single word', () => {
    const screen = [
      '→ baxian',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('codex_idle_prompt');
  });

  it('YOLO mode banner recognized as visible idle', () => {
    const screen = 'permissions: YOLO mode';
    const result = evaluateManifest(manifest, input(screen));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('codex_idle_prompt');
    expect(result.visibleIdle).toBe(true);
  });

  it('stale OSC Action Required overridden by YOLO mode banner', () => {
    const screen = 'permissions: YOLO mode';
    const result = evaluateManifest(manifest, input(screen, 'Action Required'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('codex_idle_prompt');
  });

  it('stale weak blocker suppressed by YOLO mode below', () => {
    const screen = [
      'Continue? [y/n]',
      'permissions: YOLO mode',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('weak_blocker');
  });

  it('YOLO text embedded in command does NOT trigger idle', () => {
    const screen = 'grep "permissions: YOLO mode" config.ts';
    const result = evaluateManifest(manifest, input(screen));
    expect(result.matchedRuleId).not.toBe('codex_idle_prompt');
  });

  it('bare › in mid-tail does NOT trigger idle when output follows', () => {
    const screen = [
      'Working (3s)',
      '›',
      'still streaming',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, 'Action Required'));
    expect(result.matchedRuleId).not.toBe('codex_idle_prompt');
  });

  it('→ composer in mid-tail does NOT trigger idle when output follows', () => {
    const screen = [
      'still streaming',
      '→ baxian git:(main)',
      'more output',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, 'Action Required'));
    expect(result.matchedRuleId).not.toBe('codex_idle_prompt');
  });

  it('stale OSC working overridden by visible screen idle', () => {
    const screen = [
      '→ baxian git:(main)',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, '⠁ codex'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('codex_idle_prompt');
  });

  it('stale OSC working overridden by ready-anchor idle', () => {
    const screen = [
      '› finished task',
      '',
      '  baxian · idle',
    ].join('\n');
    const result = evaluateManifest(manifest, input(screen, '⠁ codex'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('codex_idle_prompt');
  });
});
