import { describe, it, expect } from 'vitest';
import { evaluateManifest, type AgentManifest } from '../../../src/agent/detect/manifest.js';
import type { DetectionInput } from '../../../src/agent/detect/region.js';
import opencodeManifest from '../../../src/agent/detect/manifests/opencode.json' with { type: 'json' };

const manifest = opencodeManifest as AgentManifest;

function input(screen: string): DetectionInput {
  return { screen, oscTitle: '' };
}

interface Case {
  name: string;
  lines: string[];
  expect: { state?: string; rule?: string | undefined; visibleBlocker?: boolean; visibleWorking?: boolean; visibleIdle?: boolean };
}

const cases: Case[] = [
  {
    name: '非 YOLO 外部目录权限 prompt（真实截屏 perm2-oc，issue #475）',
    lines: [
      "  ┃",
      "  ┃  Run this exact bash command: touch /tmp/bx475-perm-probe",
      "  ┃",
      "",
      "     $ touch /tmp/bx475-perm-probe",
      "",
      "     ▣  Build · GLM-5.2",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "  ┃",
      "  ┃  △ Permission required",
      "  ┃    ← Access external directory /tmp",
      "  ┃",
      "  ┃  Patterns",
      "  ┃                                                                                                                                                             /private/tmp/claude-501/-Users-",
      "  ┃  - /tmp/*                                                                                                                                                   devuser--baxian-repos-example-baxian/",
      "  ┃                                                                                                                                                             f2fbbf50-44f3-4478-b9b7-2f1da4c55fad/",
      "  ┃                                                                                                                                                             scratchpad/yolo-probe/wd-oc",
      "  ┃   Allow once   Allow always   Reject                                                                       ctrl+f fullscreen  ⇆ select  enter confirm",
      "  ┃                                                                                                                                                             • OpenCode 1.17.16",
    ],
    expect: { state: 'pending', rule: 'permission_required', visibleBlocker: true },
  },
  {
    name: 'progress bar + "esc interrupt" (no "to", post-rewrite) is working',
    lines: ['   ■■■■⬝⬝⬝⬝  esc interrupt                       tab agents  ctrl+p commands'],
    expect: { state: 'working', rule: 'interrupt_hint_working', visibleWorking: true },
  },
  {
    name: 'herdr-listed "esc to interrupt" wording is also working',
    lines: ['some tool output  esc to interrupt'],
    expect: { state: 'working', rule: 'interrupt_hint_working' },
  },
  {
    name: 'progress bar alone (no interrupt text) is working',
    lines: ['   ⬝⬝⬝⬝⬝⬝⬝■                                      '],
    expect: { state: 'working', rule: 'progress_bar_working', visibleWorking: true },
  },
  {
    name: 'ctrl+c interrupt footer alone (bar wrapped away) is working',
    lines: ['  ctrl+c to interrupt          ctrl+p commands'],
    expect: { state: 'working', rule: 'interrupt_hint_working', visibleWorking: true },
  },
  {
    name: 'triangle permission prompt is pending',
    lines: ['△ Permission required', '  Allow once'],
    expect: { state: 'pending', rule: 'permission_required', visibleBlocker: true },
  },
  {
    name: 'permission title with allow/reject options is pending',
    lines: ['Permission required', '  Allow once', '  Allow always', '  Reject'],
    expect: { state: 'pending', rule: 'permission_required', visibleBlocker: true },
  },
  {
    name: 'idle composer footer is idle with visibleIdle',
    lines: ['┃  Build auto · Big Pickle OpenCode Zen', '                8.3K (4%)  ctrl+p commands'],
    expect: { state: 'idle', rule: 'idle_composer', visibleIdle: true },
  },
  {
    name: 'working progress bar wins over the idle composer footer on the same screen',
    lines: ['   ■■■■⬝⬝⬝⬝  esc interrupt                       tab agents  ctrl+p commands'],
    expect: { state: 'working' },
  },
  {
    name: 'unrecognized screen falls back to idle',
    lines: ['just some random log output'],
    expect: { state: 'idle', rule: undefined },
  },
];

describe('opencode manifest', () => {
  it.each(cases)('$name', ({ lines, expect: want }) => {
    const result = evaluateManifest(manifest, input(lines.join('\n')));
    if (want.state !== undefined) expect(result.state).toBe(want.state);
    if ('rule' in want) expect(result.matchedRuleId).toBe(want.rule);
    if (want.visibleBlocker !== undefined) expect(result.visibleBlocker).toBe(want.visibleBlocker);
    if (want.visibleWorking !== undefined) expect(result.visibleWorking).toBe(want.visibleWorking);
    if (want.visibleIdle !== undefined) expect(result.visibleIdle).toBe(want.visibleIdle);
  });
});
