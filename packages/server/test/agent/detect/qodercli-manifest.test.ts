import { describe, it, expect } from 'vitest';
import { QODER_NONYOLO_SHELL_PERMISSION_LINES } from '../runtime-captures.js';
import { evaluateManifest, type AgentManifest } from '../../../src/agent/detect/manifest.js';
import type { DetectionInput } from '../../../src/agent/detect/region.js';
import qodercliManifest from '../../../src/agent/detect/manifests/qodercli.json' with { type: 'json' };

const manifest = qodercliManifest as AgentManifest;

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
    name: '非 YOLO shell 权限 prompt（真实截屏 perm-qoder，issue #475）',
    lines: QODER_NONYOLO_SHELL_PERMISSION_LINES,
    expect: { state: 'pending', rule: 'confirmation_or_input_blocker', visibleBlocker: true },
  },
  {
    name: 'braille spinner with "(esc to cancel," is working',
    lines: ['⠼ Thinking... (esc to cancel, 3s)'],
    expect: { state: 'working', rule: 'cancel_hint_working', visibleWorking: true },
  },
  {
    name: 'braille spinner line alone is working',
    lines: ['⠙ Thinking...'],
    expect: { state: 'working', rule: 'spinner_working', visibleWorking: true },
  },
  {
    name: 'braille spinner with non-ASCII activity text is working (herdr \\p{Alphabetic})',
    lines: ['⠼ 正在思考中...'],
    expect: { state: 'working', rule: 'spinner_working', visibleWorking: true },
  },
  {
    name: 'measured "Permission Required" prompt is pending',
    lines: ['? Bash(echo hello > test.txt)', 'Permission Required', 'Allow this command to run?', '❯ 1. Allow once'],
    expect: { state: 'pending', rule: 'confirmation_or_input_blocker', visibleBlocker: true },
  },
  {
    name: 'herdr-listed "waiting for user confirmation" wording is also pending',
    lines: ['waiting for user confirmation', '  1. yes', '  2. no'],
    expect: { state: 'pending', rule: 'confirmation_or_input_blocker', visibleBlocker: true },
  },
  {
    name: 'idle composer placeholder falls back to default idle (herdr: no idle rules)',
    lines: ['*   Type your message or @path/to/file'],
    expect: { state: 'idle', rule: undefined },
  },
  {
    name: 'confirmation blocker wins over a stale spinner line on the same screen',
    lines: ['⠙ Thinking...', 'Permission Required', 'Allow this command to run?'],
    expect: { state: 'pending', rule: 'confirmation_or_input_blocker' },
  },
  {
    name: 'unrecognized screen falls back to idle',
    lines: ['just some random log output'],
    expect: { state: 'idle', rule: undefined },
  },
];

describe('qodercli manifest', () => {
  it.each(cases)('$name', ({ lines, expect: want }) => {
    const result = evaluateManifest(manifest, input(lines.join('\n')));
    if (want.state !== undefined) expect(result.state).toBe(want.state);
    if ('rule' in want) expect(result.matchedRuleId).toBe(want.rule);
    if (want.visibleBlocker !== undefined) expect(result.visibleBlocker).toBe(want.visibleBlocker);
    if (want.visibleWorking !== undefined) expect(result.visibleWorking).toBe(want.visibleWorking);
    if (want.visibleIdle !== undefined) expect(result.visibleIdle).toBe(want.visibleIdle);
  });
});
