import { describe, it, expect } from 'vitest';
import { evaluateManifest, type AgentManifest } from '../../../src/agent/detect/manifest.js';
import type { DetectionInput } from '../../../src/agent/detect/region.js';
import codexManifest from '../../../src/agent/detect/manifests/codex.json' with { type: 'json' };

const manifest = codexManifest as AgentManifest;

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

const cases: Case[] = [
  {
    name: '非 YOLO home 越界 escalation prompt（真实截屏 perm2-codex，issue #475）',
    lines: [
      "• Done.",
      "",
      "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
      "",
      "",
      "› Run this exact bash command: touch ~/bx475-perm-probe",
      "",
      "",
      "• Running touch ~/bx475-perm-probe",
      "",
      "",
      "  Would you like to run the following command?",
      "",
      "  Environment: local",
      "",
      "  Reason: Do you want to allow creating /Users/devuser/bx475-perm-probe in your home directory?",
      "",
      "  $ touch ~/bx475-perm-probe",
      "",
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again for commands that start with `touch '~/bx475-perm-probe'` (p)",
      "  3. No, and tell Codex what to do differently (esc)",
      "",
      "  Press enter to confirm or esc to cancel",
    ],
    expect: { state: 'pending', rule: 'live_strong_blocker', visibleBlocker: true },
  },
  {
    name: 'detects OSC "Action Required" as blocked',
    lines: [''],
    osc: 'Action Required',
    expect: { state: 'pending', visibleBlocker: true },
  },
  {
    name: 'detects OSC braille spinner as working',
    lines: [''],
    osc: '⠁ codex',
    expect: { state: 'working' },
  },
  {
    name: 'detects transcript viewer as skipStateUpdate',
    lines: [
      '› prompt here',
      '↑/↓ to scroll · pgup/pgdn to page · home/end to jump · q to quit',
      'esc to edit prev',
    ],
    expect: { rule: 'transcript_viewer', skipStateUpdate: true },
  },
  {
    name: 'detects strong blocker (allow command) after prompt marker',
    lines: [
      '› previous prompt',
      'Allow command?',
      'rm -rf /tmp/test',
    ],
    expect: { state: 'pending', rule: 'live_strong_blocker', visibleBlocker: true },
  },
  {
    name: 'blocker with numbered selection is not cut by prompt marker',
    lines: [
      '›',
      'Allow command?',
      '› 1. Yes',
      '  2. No',
    ],
    expect: { state: 'pending', rule: 'live_strong_blocker' },
  },
  {
    name: 'detects weak blocker [y/n] with visibleBlocker',
    lines: ['Continue? [y/n]'],
    expect: { state: 'pending', rule: 'weak_blocker', visibleBlocker: true },
  },
  {
    name: 'stale weak blocker does not override current working line',
    lines: [
      'Do you want to continue?',
      'Yes (y)',
      '',
      'Working (8s)',
    ],
    expect: { rule: 'working_line', state: 'working' },
  },
  {
    name: 'OSC non-spinner non-action-required is idle',
    lines: [''],
    osc: 'codex ~/project',
    expect: { state: 'idle', rule: 'osc_title_idle' },
  },
  {
    name: 'stale weak blocker is suppressed by bare › prompt',
    lines: [
      'Do you want to continue?',
      'Yes (y)',
      '',
      '›',
    ],
    expect: { notRule: 'weak_blocker' },
  },
  {
    name: 'transcript viewer footer does not override active blocker when not on last line',
    lines: [
      '› prompt here',
      '↑/↓ to scroll · pgup/pgdn to page · home/end to jump · q to quit',
      'esc to edit prev',
      '',
      'Allow command?',
      'rm -rf /tmp/test',
    ],
    expect: { notRule: 'transcript_viewer', rule: 'live_strong_blocker' },
  },
  {
    name: 'falls back to idle on unrecognized screen',
    lines: ['random output'],
    expect: { state: 'idle', rule: undefined },
  },
  {
    name: 'visible screen blocker overrides stale OSC working spinner',
    lines: [
      '› previous prompt',
      'Allow command?',
      'rm -rf /tmp/test',
    ],
    osc: '⠁ codex',
    expect: { state: 'pending', visibleBlocker: true, rule: 'live_strong_blocker' },
  },
  {
    name: 'stale strong blocker loses to current Working line',
    lines: [
      '› do something',
      'Allow command?',
      'rm -rf test',
      'Working (3s)',
    ],
    expect: { notRule: 'live_strong_blocker', rule: 'working_line' },
  },
  {
    name: 'stale OSC Action Required overridden by visible idle prompt',
    lines: ['›'],
    osc: 'Action Required',
    expect: { state: 'idle', rule: 'codex_idle_prompt' },
  },
  {
    name: 'stale OSC Action Required overridden by visible Working line',
    lines: [
      '› do something',
      'Working (5s)',
    ],
    osc: 'Action Required',
    expect: { state: 'working', rule: 'working_line' },
  },
  {
    name: 'new blocker after old Working is not suppressed',
    lines: [
      '› do something',
      'Working (3s)',
      'Allow command?',
      'Press Enter to confirm or Esc to cancel',
    ],
    expect: { state: 'pending', rule: 'live_strong_blocker' },
  },
  {
    name: 'arrow composer → at tail excludes stale esc-to-interrupt',
    lines: [
      '› old prompt',
      'esc to interrupt',
      '→ baxian git:(main)',
    ],
    expect: { notRule: 'esc_to_interrupt_working' },
  },
  {
    name: 'OSC pending prefers screen blocker over screen idle evidence',
    lines: [
      '›',
      'Allow command?',
      'Press Enter to confirm or Esc to cancel',
    ],
    osc: 'Action Required',
    expect: { state: 'pending', rule: 'live_strong_blocker' },
  },
  {
    name: 'arrow composer → recognized as visible idle',
    lines: [
      'some output',
      '→ baxian git:(main)',
    ],
    expect: { state: 'idle', rule: 'codex_idle_prompt', visibleIdle: true },
  },
  {
    name: 'stale OSC Action Required overridden by arrow composer →',
    lines: ['→ baxian git:(main)'],
    osc: 'Action Required',
    expect: { state: 'idle', rule: 'codex_idle_prompt' },
  },
  {
    name: 'stale weak blocker suppressed by arrow composer →',
    lines: [
      'Continue? [y/n]',
      '→ baxian git:(main)',
    ],
    expect: { notRule: 'weak_blocker' },
  },
  {
    name: 'stale strong blocker suppressed by arrow composer →',
    lines: [
      '› old prompt',
      'Allow command?',
      'Press Enter to confirm or Esc to cancel',
      '→ baxian git:(main)',
    ],
    expect: { notRule: 'live_strong_blocker' },
  },
  {
    name: 'arrow composer with user input is NOT idle (strict shape)',
    lines: ['→ run tests'],
    expect: { notRule: 'codex_idle_prompt' },
  },
  {
    name: 'ready-anchor (› prompt + project footer) recognized as visible idle',
    lines: [
      '› do something',
      '',
      '  baxian · idle',
    ],
    expect: { state: 'idle', rule: 'codex_idle_prompt', visibleIdle: true },
  },
  {
    name: 'stale OSC Action Required overridden by ready-anchor',
    lines: [
      '› previous task',
      '',
      '  baxian · idle',
    ],
    osc: 'Action Required',
    expect: { state: 'idle', rule: 'codex_idle_prompt' },
  },
  {
    name: 'stale weak blocker suppressed by ready-anchor below',
    lines: [
      'Continue? [y/n]',
      '› finished task',
      '',
      '  baxian · idle',
    ],
    expect: { notRule: 'weak_blocker' },
  },
  {
    name: 'stale strong blocker suppressed by ready-anchor below',
    lines: [
      '› old prompt',
      'Allow command?',
      'Press Enter to confirm or Esc to cancel',
      '› finished task',
      '',
      '  baxian · idle',
    ],
    expect: { notRule: 'live_strong_blocker' },
  },
  {
    name: 'ready-anchor in mid-screen does NOT trigger idle (must be at tail end)',
    lines: [
      '› old prompt',
      '',
      '  baxian · idle',
      'Working (3s)',
      'esc to interrupt',
    ],
    expect: { notRule: 'codex_idle_prompt' },
  },
  {
    name: 'arrow composer without git context still matches if single word',
    lines: ['→ baxian'],
    expect: { state: 'idle', rule: 'codex_idle_prompt' },
  },
  {
    name: 'YOLO mode banner recognized as visible idle',
    lines: ['permissions: YOLO mode'],
    expect: { state: 'idle', rule: 'codex_idle_prompt', visibleIdle: true },
  },
  {
    name: 'stale OSC Action Required overridden by YOLO mode banner',
    lines: ['permissions: YOLO mode'],
    osc: 'Action Required',
    expect: { state: 'idle', rule: 'codex_idle_prompt' },
  },
  {
    name: 'stale weak blocker suppressed by YOLO mode below',
    lines: [
      'Continue? [y/n]',
      'permissions: YOLO mode',
    ],
    expect: { notRule: 'weak_blocker' },
  },
  {
    name: 'YOLO text embedded in command does NOT trigger idle',
    lines: ['grep "permissions: YOLO mode" config.ts'],
    expect: { notRule: 'codex_idle_prompt' },
  },
  {
    name: 'bare › in mid-tail does NOT trigger idle when output follows',
    lines: [
      'Working (3s)',
      '›',
      'still streaming',
    ],
    osc: 'Action Required',
    expect: { notRule: 'codex_idle_prompt' },
  },
  {
    name: '→ composer in mid-tail does NOT trigger idle when output follows',
    lines: [
      'still streaming',
      '→ baxian git:(main)',
      'more output',
    ],
    osc: 'Action Required',
    expect: { notRule: 'codex_idle_prompt' },
  },
  {
    name: 'stale OSC working overridden by visible screen idle',
    lines: ['→ baxian git:(main)'],
    osc: '⠁ codex',
    expect: { state: 'idle', rule: 'codex_idle_prompt' },
  },
  {
    name: 'stale OSC working overridden by ready-anchor idle',
    lines: [
      '› finished task',
      '',
      '  baxian · idle',
    ],
    osc: '⠁ codex',
    expect: { state: 'idle', rule: 'codex_idle_prompt' },
  },
];

describe('codex manifest', () => {
  it.each(cases)('$name', ({ lines, osc, expect: want }) => {
    const result = evaluateManifest(manifest, input(lines.join('\n'), osc ?? ''));
    if (want.state !== undefined) expect(result.state).toBe(want.state);
    if ('rule' in want) expect(result.matchedRuleId).toBe(want.rule);
    if (want.notRule !== undefined) expect(result.matchedRuleId).not.toBe(want.notRule);
    if (want.visibleBlocker !== undefined) expect(result.visibleBlocker).toBe(want.visibleBlocker);
    if (want.visibleIdle !== undefined) expect(result.visibleIdle).toBe(want.visibleIdle);
    if (want.skipStateUpdate !== undefined) expect(result.skipStateUpdate).toBe(want.skipStateUpdate);
  });
});
