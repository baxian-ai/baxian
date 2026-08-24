import { describe, it, expect } from 'vitest';
import { CC_NONYOLO_BASH_PERMISSION_LINES } from '../runtime-captures.js';
import { evaluateManifest, type AgentManifest } from '../../../src/agent/detect/manifest.js';
import type { DetectionInput } from '../../../src/agent/detect/region.js';
import claudeManifest from '../../../src/agent/detect/manifests/claude-code.json' with { type: 'json' };

const manifest = claudeManifest as AgentManifest;

function input(screen: string, oscTitle = '', oscProgress = ''): DetectionInput {
  return { screen, oscTitle, oscProgress };
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
  progress?: string;
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
    name: '非 YOLO bash 写文件权限 prompt（真实截屏 perm2-cc，issue #475）',
    lines: CC_NONYOLO_BASH_PERMISSION_LINES,
    expect: { state: 'pending', rule: 'generic_permission_prompt', visibleBlocker: true },
  },
  {
    name: 'detects OSC braille spinner as working',
    lines: [''],
    osc: '⠁ Reading file',
    expect: { state: 'working', rule: 'osc_title_working' },
  },
  {
    name: 'detects OSC half-circle spinner as working (claude-code 2.1.228+, herdr charset)',
    lines: [''],
    osc: '◐ Baking…',
    expect: { state: 'working', rule: 'osc_title_working' },
  },
  {
    name: 'detects OSC ✳ as idle',
    lines: [''],
    osc: '✳ ~/code/project',
    expect: { state: 'idle', rule: 'osc_title_idle', visibleIdle: true },
  },
  {
    name: 'detects OSC progress 4;0 as idle (herdr osc_progress region)',
    lines: [''],
    progress: '4;0;',
    expect: { state: 'idle', rule: 'osc_progress_idle' },
  },
  {
    name: 'detects bash permission prompt as blocked',
    lines: [...BASH_PERMISSION_PROMPT],
    expect: { state: 'pending', rule: 'bash_permission_prompt', visibleBlocker: true },
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
      ' Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    ],
    expect: { state: 'pending', rule: 'live_blocked_form', visibleBlocker: true },
  },
  {
    name: 'detects dynamic workflow prompt as blocked',
    lines: [
      ' Run a dynamic workflow?',
      ' Enter to run · Esc to cancel',
    ],
    expect: { state: 'pending', rule: 'dynamic_workflow_prompt', visibleBlocker: true },
  },
  {
    name: 'detects live prompt box as idle (prompt between horizontal rules)',
    lines: [
      'history output',
      '──────────────',
      '❯ ',
      '──────────────',
    ],
    expect: { state: 'idle', rule: 'live_prompt_box', visibleIdle: true },
  },
  {
    name: 'model picker menu triggers skipStateUpdate',
    lines: [
      ' Select model',
      ' ❯ 1. Default (recommended)',
      '   2. Opus',
      ' Enter to set as default · Esc to cancel',
    ],
    expect: { state: 'unknown', rule: 'model_picker_menu', skipStateUpdate: true },
  },
  {
    name: 'detects active spinner as working (herdr live_turn_working)',
    lines: ['✻ Pondering… (3s · esc to interrupt)'],
    expect: { state: 'working', rule: 'live_turn_working' },
  },
  {
    name: 'detects the ⏸⏵ status line with esc to interrupt as working',
    lines: ['⏵ Thinking · esc to interrupt'],
    expect: { state: 'working', rule: 'live_turn_working' },
  },
  {
    name: 'a bare unboxed ❯ composer falls back to default idle (herdr: live_prompt_box needs the box)',
    lines: ['some transcript', '❯ '],
    expect: { state: 'idle', rule: undefined },
  },
  {
    name: 'falls back to idle on unrecognized screen',
    lines: ['just some random output'],
    expect: { state: 'idle', rule: undefined },
  },
  {
    name: 'a working OSC title outranks a boxed idle composer — no arbitration (herdr)',
    lines: [
      'done',
      '──────────────',
      '❯ ',
      '──────────────',
    ],
    osc: '⠧ thinking',
    expect: { state: 'working', rule: 'osc_title_working' },
  },
  {
    name: 'a working OSC title outranks an NBSP composer screen (herdr: no screen idle rule matches it)',
    lines: ['\u00a0❯ '],
    osc: '⠧ thinking',
    expect: { state: 'working', rule: 'osc_title_working' },
  },
  {
    name: 'live_turn_working outranks live_prompt_box when both are visible',
    lines: [
      '✻ Baking… (12s · esc to interrupt)',
      '──────────────',
      '❯ ',
      '──────────────',
    ],
    expect: { state: 'working', rule: 'live_turn_working' },
  },
  {
    name: 'a blocked form outranks a working spinner (980 vs 970)',
    lines: [
      '✻ Baking… (12s · esc to interrupt)',
      ' Enter to confirm · Esc to cancel',
    ],
    expect: { state: 'pending', rule: 'live_blocked_form' },
  },
  {
    name: 'legacy blocker "waiting for permission" is pending (herdr: not a visible blocker)',
    lines: ['waiting for permission'],
    expect: { state: 'pending', rule: 'legacy_no_prompt_blocker', visibleBlocker: false },
  },
  {
    name: 'legacy blocker "tab to amend" is pending (herdr: not a visible blocker)',
    lines: ['Tab to amend'],
    expect: { state: 'pending', rule: 'legacy_no_prompt_blocker', visibleBlocker: false },
  },
  {
    name: 'legacy blocker is suppressed by a bare ❯ line anywhere on screen (herdr not-gate)',
    lines: ['waiting for permission', '❯', ''],
    expect: { notRule: 'legacy_no_prompt_blocker' },
  },
  {
    name: 'a bare > line does NOT suppress the legacy blocker (herdr not-gate is ❯ only)',
    lines: ['waiting for permission', '>', ''],
    expect: { state: 'pending', rule: 'legacy_no_prompt_blocker' },
  },
  {
    name: 'transcript text scrolled out of the bottom-3 window does not suppress a blocked form',
    lines: [
      'Showing detailed transcript',
      'line a',
      'ctrl+o to toggle',
      '',
      'Enter to confirm · Esc to cancel',
    ],
    expect: { notRule: 'transcript_viewer', rule: 'live_blocked_form', state: 'pending' },
  },
  {
    name: 'a ❯ Yes selection between rules reads as a live prompt box under herdr (no strict empty-line shape)',
    lines: [
      'Would you like to proceed?',
      '────────────────',
      '❯ Yes',
      '────────────────',
    ],
    expect: { state: 'idle', rule: 'live_prompt_box' },
  },
  {
    name: 'a wrapped footer without the transcript phrase in the bottom window no longer beats the composer (herdr shape)',
    lines: [
      'transcript body',
      '────────────────',
      '❯ ',
      '────────────────',
      'ctrl+o to toggle · esc to',
      'close',
    ],
    expect: { notRule: 'transcript_viewer_wrapped', rule: 'live_prompt_box' },
  },
  {
    name: 'a historical menu footer with the transcript phrase out of window classifies as the blocked form (herdr)',
    lines: [
      'Showing detailed transcript',
      'Earlier output from a previous menu:',
      'Enter to confirm · Esc to cancel',
      '',
      'ctrl+o to toggle',
    ],
    expect: { rule: 'live_blocked_form', state: 'pending' },
  },
  {
    name: 'a stale bash permission prompt keeps matching over a bare unboxed ❯-space (herdr: not-gate needs a bare ❯ line)',
    lines: [
      ...BASH_PERMISSION_PROMPT,
      '',
      '❯x',
    ],
    expect: { state: 'pending', rule: 'bash_permission_prompt' },
  },
  {
    name: 'a current spinner outranks a stale permission prompt (970 vs 850)',
    lines: [
      ...BASH_PERMISSION_PROMPT,
      '',
      '✻ Baking… (5s · esc to interrupt)',
    ],
    expect: { state: 'working', rule: 'live_turn_working' },
  },
  {
    name: 'a stale spinner line inside the bottom-12 window keeps matching after Worked-for (herdr: window-only recency)',
    lines: [
      '✻ Baking… (5s · esc to interrupt)',
      '✻ Worked for 10s',
      '',
      '❯ ',
    ],
    expect: { state: 'working', rule: 'live_turn_working' },
  },
  {
    name: 'the bypass permissions banner is not idle evidence under herdr (default idle)',
    lines: ['⏵⏵ bypass permissions on'],
    expect: { state: 'idle', rule: undefined },
  },
  {
    name: 'a working OSC title wins over the bypass permissions banner screen',
    lines: ['⏵⏵ bypass permissions on'],
    osc: '⠧ thinking',
    expect: { state: 'working', rule: 'osc_title_working' },
  },
  {
    name: 'a stale blocked-form footer outranks a current model picker (herdr: 980 vs 900, no position awareness)',
    lines: [
      ' Enter to select · Arrow keys to navigate · Esc to cancel',
      '',
      ' Select model',
      ' Enter to set as default',
    ],
    expect: { state: 'pending', rule: 'live_blocked_form' },
  },
  {
    name: 'model picker with do-you-want-to-proceed on screen is killed by its not-gate',
    lines: [
      'Do you want to proceed?',
      ' Select model',
      ' Enter to set as default · Esc to cancel',
    ],
    expect: { notRule: 'model_picker_menu' },
  },
  {
    name: 'background shells status line is working (herdr background_shell_working)',
    lines: ['⏸ plan mode · 2 shells ·'],
    expect: { state: 'working', rule: 'background_shell_working' },
  },
  {
    name: 'waiting-for-background-agents above the prompt box is working (herdr background_agents_working)',
    lines: [
      '✻ Waiting for 2 background agents to finish',
      '',
      '──────────────',
      '❯ ',
      '──────────────',
    ],
    expect: { state: 'working', rule: 'background_agents_working' },
  },
  {
    name: 'MCP tasks still running is working (herdr background_mcp_task_working)',
    lines: ['· Running research task · 2 MCP tasks still running'],
    expect: { state: 'working', rule: 'background_mcp_task_working' },
  },
  {
    name: 'the /btw overlay is working (herdr btw_overlay_working)',
    lines: [
      '/btw session notes',
      'esc to close',
    ],
    expect: { state: 'working', rule: 'btw_overlay_working' },
  },
];

describe('claude-code manifest', () => {
  it.each(cases)('$name', ({ lines, osc, progress, expect: want }) => {
    const result = evaluateManifest(manifest, input(lines.join('\n'), osc ?? '', progress ?? ''));
    if (want.state !== undefined) expect(result.state).toBe(want.state);
    if ('rule' in want) expect(result.matchedRuleId).toBe(want.rule);
    if (want.notRule !== undefined) expect(result.matchedRuleId).not.toBe(want.notRule);
    if (want.visibleBlocker !== undefined) expect(result.visibleBlocker).toBe(want.visibleBlocker);
    if (want.visibleIdle !== undefined) expect(result.visibleIdle).toBe(want.visibleIdle);
    if (want.skipStateUpdate !== undefined) expect(result.skipStateUpdate).toBe(want.skipStateUpdate);
  });
});
