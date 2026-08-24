import { describe, it, expect } from 'vitest';
import { CODEX_NONYOLO_ESCALATION_LINES } from '../runtime-captures.js';
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
    lines: CODEX_NONYOLO_ESCALATION_LINES,
    expect: { state: 'pending', rule: 'live_strong_blocker', visibleBlocker: true },
  },
  {
    name: 'detects OSC "Action Required" as blocked',
    lines: [''],
    osc: 'Action Required',
    expect: { state: 'pending', rule: 'osc_title_blocked', visibleBlocker: true },
  },
  {
    name: 'detects an OSC spinner-frame title as working (herdr 10-frame set)',
    lines: [''],
    osc: '⠙ codex',
    expect: { state: 'working', rule: 'osc_title_working' },
  },
  {
    name: 'a braille char outside the herdr spinner set is idle evidence, not working',
    lines: [''],
    osc: '⠁ codex',
    expect: { state: 'idle', rule: 'osc_title_idle' },
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
    name: 'a "› 1. Yes" selection line is itself a prompt marker and cuts the blocker region (herdr codex_prompt_line)',
    lines: [
      '›',
      'Allow command?',
      '› 1. Yes',
      '  2. No',
    ],
    expect: { state: 'idle', rule: undefined },
  },
  {
    name: 'detects weak blocker [y/n] (herdr: weak_blocker is not a visible blocker)',
    lines: ['Continue? [y/n]'],
    expect: { state: 'pending', rule: 'weak_blocker', visibleBlocker: false },
  },
  {
    name: 'a stale weak blocker keeps matching over a later Working line (herdr: no suppression)',
    lines: [
      'Do you want to continue?',
      'Yes (y)',
      '',
      'Working (8s)',
    ],
    expect: { state: 'pending', rule: 'weak_blocker' },
  },
  {
    name: 'OSC non-spinner non-action-required is idle',
    lines: [''],
    osc: 'codex ~/project',
    expect: { state: 'idle', rule: 'osc_title_idle' },
  },
  {
    name: 'a stale weak blocker keeps matching over a bare › prompt (herdr: no suppression)',
    lines: [
      'Do you want to continue?',
      'Yes (y)',
      '',
      '›',
    ],
    expect: { state: 'pending', rule: 'weak_blocker' },
  },
  {
    name: 'transcript viewer (p1000) outranks a strong blocker (p900) sharing the region (herdr priorities)',
    lines: [
      '› prompt here',
      '↑/↓ to scroll · pgup/pgdn to page · home/end to jump · q to quit',
      'esc to edit prev',
      '',
      'Allow command?',
      'rm -rf /tmp/test',
    ],
    expect: { rule: 'transcript_viewer', skipStateUpdate: true },
  },
  {
    name: 'falls back to idle on unrecognized screen',
    lines: ['random output'],
    expect: { state: 'idle', rule: undefined },
  },
  {
    name: 'a screen blocker wins over a non-frame braille title (title is idle evidence at p100)',
    lines: [
      '› previous prompt',
      'Allow command?',
      'rm -rf /tmp/test',
    ],
    osc: '⠁ codex',
    expect: { state: 'pending', visibleBlocker: true, rule: 'live_strong_blocker' },
  },
  {
    name: 'a spinner-frame OSC title (p1050) outranks a screen blocker (p900) — no arbitration (herdr)',
    lines: [
      '› previous prompt',
      'Allow command?',
      'rm -rf /tmp/test',
    ],
    osc: '⠙ codex',
    expect: { state: 'working', rule: 'osc_title_working' },
  },
  {
    name: 'a stale strong blocker keeps matching over a later Working line (herdr: no suppression)',
    lines: [
      '› do something',
      'Allow command?',
      'rm -rf test',
      'Working (3s)',
    ],
    expect: { state: 'pending', rule: 'live_strong_blocker' },
  },
  {
    name: 'an Action Required OSC title (p1100) outranks a bare › prompt — no arbitration (herdr)',
    lines: ['›'],
    osc: 'Action Required',
    expect: { state: 'pending', rule: 'osc_title_blocked' },
  },
  {
    name: 'an Action Required OSC title outranks a screen strong blocker (both pending, title p1100 wins)',
    lines: [
      '›',
      'Allow command?',
      'Press Enter to confirm or Esc to cancel',
    ],
    osc: 'Action Required',
    expect: { state: 'pending', rule: 'osc_title_blocked' },
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
    name: 'the → shell composer is not a codex prompt marker nor idle evidence (herdr: default idle)',
    lines: [
      'some output',
      '→ baxian git:(main)',
    ],
    expect: { state: 'idle', rule: undefined },
  },
  {
    name: 'a stale weak blocker keeps matching over a shell composer below (herdr: no suppression)',
    lines: [
      'Continue? [y/n]',
      '→ baxian git:(main)',
    ],
    expect: { state: 'pending', rule: 'weak_blocker' },
  },
  {
    name: 'a newer › marker cuts an older strong blocker out of the region',
    lines: [
      '› old prompt',
      'Allow command?',
      'Press enter to confirm or esc to cancel',
      '› finished task',
      '',
      '  baxian · idle',
    ],
    expect: { state: 'idle', rule: undefined },
  },
  {
    name: 'the YOLO banner is not idle evidence under herdr (default idle only)',
    lines: ['permissions: YOLO mode'],
    expect: { state: 'idle', rule: undefined },
  },
  {
    name: 'an Action Required title wins over a YOLO banner screen (herdr: title p1100)',
    lines: ['permissions: YOLO mode'],
    osc: 'Action Required',
    expect: { state: 'pending', rule: 'osc_title_blocked' },
  },
  {
    name: '• Working with esc to interrupt in the bottom window is working (screen_working_fallback)',
    lines: [
      '› task',
      '',
      '• Working (12s • esc to interrupt)',
    ],
    expect: { state: 'working', rule: 'screen_working_fallback' },
  },
  {
    name: '■ Conversation interrupted suppresses screen_working_fallback',
    lines: [
      '■ Conversation interrupted',
      '• Working (12s • esc to interrupt)',
    ],
    expect: { notRule: 'screen_working_fallback' },
  },
  {
    name: 'trust directory dialog at the top of the screen is pending',
    lines: [
      '> You are in /Users/dev/repo',
      '',
      'Do you trust the contents of this directory?',
      '  1. Yes, continue',
      '  2. No, exit',
    ],
    expect: { state: 'pending', rule: 'trust_directory', visibleBlocker: true },
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
