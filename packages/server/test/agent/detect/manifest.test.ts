import { describe, it, expect } from 'vitest';
import { compileManifest, evaluateManifest, type AgentManifest } from '../../../src/agent/detect/manifest.js';
import { manifests } from '../../../src/agent/detect/classify.js';
import type { DetectionInput } from '../../../src/agent/detect/region.js';

const claudeCodeManifest = manifests['claude-code'];
const codexManifest = manifests.codex;

function input(screen: string, oscTitle = ''): DetectionInput {
  return { screen, oscTitle };
}

const sampleManifest: AgentManifest = {
  id: 'claude-code',
  rules: [
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1100,
      region: 'osc_title',
      visibleWorking: true,
      regex: ['^[\\u2800-\\u28FF] '],
    },
    {
      id: 'permission_prompt',
      state: 'pending',
      priority: 850,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['do you want to proceed?'],
      any: [
        { contains: ['bash command'] },
        { contains: ['tab to amend'] },
      ],
    },
    {
      id: 'idle_prompt',
      state: 'idle',
      priority: 200,
      region: 'bottom_non_empty_lines(6)',
      visibleIdle: true,
      lineRegex: ['^\\s*[❯>]\\s*$'],
    },
  ],
};

describe('evaluateManifest (herdr: pure highest-priority match)', () => {
  it('matches highest-priority rule', () => {
    const result = evaluateManifest(sampleManifest, input('', '⠁ Working on task'));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('osc_title_working');
  });

  it('matches permission prompt as blocked', () => {
    const screen = 'Run this bash command?\nDo you want to proceed?\n❯ yes\n2. no';
    const result = evaluateManifest(sampleManifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('permission_prompt');
    expect(result.visibleBlocker).toBe(true);
  });

  it('matches idle prompt', () => {
    const screen = 'previous output\n❯ \n\n';
    const result = evaluateManifest(sampleManifest, input(screen));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('idle_prompt');
    expect(result.visibleIdle).toBe(true);
  });

  it('falls back to idle for known agent with no rule match', () => {
    const result = evaluateManifest(sampleManifest, input('random output'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBeUndefined();
  });

  it('higher priority wins even if lower-priority rule also matches', () => {
    const screen = 'Do you want to proceed?\nbash command\n❯ \n';
    const result = evaluateManifest(sampleManifest, input(screen));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('permission_prompt');
  });

  it('has no screen-over-title arbitration: a working osc title beats a lower-priority idle screen', () => {
    const screen = 'previous output\n❯ \n\n';
    const result = evaluateManifest(sampleManifest, input(screen, '⠁ Working on task'));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('osc_title_working');
  });
});

describe('claude-code manifest: osc_title_working outranks transcript_viewer (herdr priorities)', () => {
  it('osc_title_working (p1100) beats transcript_viewer (p1000) while the title spins', () => {
    const screen = '\n\n\nShowing detailed transcript · ctrl+o to toggle · ↑↓ scroll · ? for shortcuts';
    const result = evaluateManifest(claudeCodeManifest, input(screen, '⠁ Reading file'));
    expect(result.matchedRuleId).toBe('osc_title_working');
    expect(result.state).toBe('working');
  });

  it('transcript_viewer matches when the phrase and a footer share the bottom 3 non-empty lines', () => {
    const screen = [
      'transcript body',
      'line a',
      'line b',
      'Showing detailed transcript',
      'ctrl+o to toggle',
    ].join('\n');
    const result = evaluateManifest(claudeCodeManifest, input(screen));
    expect(result.matchedRuleId).toBe('transcript_viewer');
    expect(result.skipStateUpdate).toBe(true);
  });

  it('transcript text scrolled out of the bottom window does not suppress an active blocker', () => {
    const screen = [
      'Showing detailed transcript',
      'line a',
      'ctrl+o to toggle',
      '',
      'Run this bash command?',
      'Do you want to proceed?',
      'Tab to amend',
      '❯ Yes',
      '2. No',
    ].join('\n');
    const result = evaluateManifest(claudeCodeManifest, input(screen));
    expect(result.matchedRuleId).not.toBe('transcript_viewer');
    expect(result.state).toBe('pending');
  });
});

describe('claude-code manifest: live_turn_working (herdr spinner shape)', () => {
  it('matches an active spinner with elapsed time', () => {
    const screen = '✻ Editing file… (12s · esc to interrupt)\n\n\n\n\n';
    const result = evaluateManifest(claudeCodeManifest, input(screen));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('live_turn_working');
  });

  it('does not match a "Worked for" completion marker (no ellipsis)', () => {
    const screen = '✻ Worked for 2m 15s\n\n❯ \n\n\n';
    const result = evaluateManifest(claudeCodeManifest, input(screen));
    expect(result.matchedRuleId).not.toBe('live_turn_working');
  });

  it('live_turn_working (p970) outranks osc_title_idle (p250)', () => {
    const screen = '✻ Hatching… (5s · esc to interrupt)\n\n\n\n\n';
    const result = evaluateManifest(claudeCodeManifest, input(screen, '✳ Claude'));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('live_turn_working');
  });
});

describe('codex manifest: screen_working_fallback (herdr rule)', () => {
  it('matches the • Working (…esc to interrupt) status line', () => {
    const screen = '› task\n\n• Working (4s • esc to interrupt)\n';
    const result = evaluateManifest(codexManifest, input(screen));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('screen_working_fallback');
  });

  it('does not match after ■ Conversation interrupted', () => {
    const screen = '■ Conversation interrupted\n• Working (4s • esc to interrupt)\n';
    const result = evaluateManifest(codexManifest, input(screen));
    expect(result.matchedRuleId).not.toBe('screen_working_fallback');
  });
});

describe('codex manifest: no screen idle rule (herdr default idle fallback)', () => {
  it('a bare › prompt falls back to default idle without a matched rule', () => {
    const screen = 'previous output\n\n› \n\n\n';
    const result = evaluateManifest(codexManifest, input(screen));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBeUndefined();
  });

  it('a non-spinner osc title is positive idle evidence (osc_title_idle)', () => {
    const result = evaluateManifest(codexManifest, input('', '~/repo — codex'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('osc_title_idle');
    expect(result.visibleIdle).toBe(true);
  });

  it('a braille spinner osc title is working, not idle', () => {
    const result = evaluateManifest(codexManifest, input('', '⠙ Fixing tests'));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('osc_title_working');
  });

  it('an Action Required osc title is pending (osc_title_blocked)', () => {
    const result = evaluateManifest(codexManifest, input('', 'Action Required: approve command'));
    expect(result.state).toBe('pending');
    expect(result.matchedRuleId).toBe('osc_title_blocked');
    expect(result.visibleBlocker).toBe(true);
  });
});

describe('compileManifest (herdr: load 期校验,拒绝静默失效的规则)', () => {
  const rule = (over: Partial<AgentManifest['rules'][number]>): AgentManifest => ({
    id: 'probe',
    rules: [{ id: 'r1', state: 'idle', priority: 1, region: 'whole_recent', contains: ['x'], ...over }],
  });

  it('未知 region 在 load 期报错并点名 rule id', () => {
    expect(() => compileManifest(rule({ region: 'bottom_lines(3)' })))
      .toThrow(/probe.*r1.*unknown region.*bottom_lines\(3\)/);
  });

  it('非法正则在 load 期报错并点名 rule id', () => {
    expect(() => compileManifest(rule({ regex: ['a(?i)b'] }))).toThrow(/probe.*r1/);
  });

  it('嵌套 gate 里的非法正则同样在 load 期报错', () => {
    expect(() => compileManifest(rule({ any: [{ lineRegex: ['('] }] }))).toThrow(/probe.*r1/);
  });

  it('合法 manifest 原样返回', () => {
    const m = rule({});
    expect(compileManifest(m)).toBe(m);
  });

  it('四份内置 manifest 全部通过校验', () => {
    for (const m of Object.values(manifests)) expect(() => compileManifest(m)).not.toThrow();
  });
});
