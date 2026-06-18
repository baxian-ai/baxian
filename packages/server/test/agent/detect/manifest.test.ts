import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { evaluateManifest, type AgentManifest } from '../../../src/agent/detect/manifest.js';
import type { DetectionInput } from '../../../src/agent/detect/region.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestDir = join(__dirname, '../../../src/agent/detect/manifests');
const claudeCodeManifest: AgentManifest = JSON.parse(
  readFileSync(join(manifestDir, 'claude-code.json'), 'utf-8'),
);
const codexManifest: AgentManifest = JSON.parse(
  readFileSync(join(manifestDir, 'codex.json'), 'utf-8'),
);

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
      region: 'oscTitle',
      visibleWorking: true,
      regex: ['^[\\u2800-\\u28FF] '],
    },
    {
      id: 'permission_prompt',
      state: 'pending',
      priority: 850,
      region: 'whole',
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
      region: 'tail(6)',
      visibleIdle: true,
      lineRegex: ['^\\s*[❯>]\\s*$'],
    },
  ],
};

describe('evaluateManifest', () => {
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
});

describe('claude-code manifest: transcript viewer skip outranks stale OSC working', () => {
  it('transcript_viewer (p1200) beats osc_title_working (p1100) when OSC title is stale', () => {
    const screen = '\n\n\nShowing detailed transcript · ctrl+o to toggle · ↑↓ scroll · ? for shortcuts';
    const result = evaluateManifest(claudeCodeManifest, input(screen, '⠁ Reading file'));
    expect(result.matchedRuleId).toBe('transcript_viewer');
    expect(result.skipStateUpdate).toBe(true);
  });

  it('transcript_viewer matches when content spans many lines', () => {
    const screen = [
      'Showing detailed transcript',
      'line a',
      'line b',
      'line c',
      'ctrl+o to toggle',
    ].join('\n');
    const result = evaluateManifest(claudeCodeManifest, input(screen));
    expect(result.matchedRuleId).toBe('transcript_viewer');
    expect(result.skipStateUpdate).toBe(true);
  });

  it('stale transcript text does not suppress active blocker', () => {
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

describe('claude-code manifest: spinner_working excludes completed spinner', () => {
  it('matches active spinner with elapsed time', () => {
    const screen = '✻ Editing file… (12s\n\n\n\n\n';
    const result = evaluateManifest(claudeCodeManifest, input(screen));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('spinner_working');
  });

  it('does not match "Worked for" completion marker', () => {
    const screen = '✻ Worked for 2m 15s\n\n❯ \n\n\n';
    const result = evaluateManifest(claudeCodeManifest, input(screen));
    expect(result.matchedRuleId).not.toBe('spinner_working');
  });
});

describe('claude-code manifest: osc_title_idle vs spinner_working priority', () => {
  it('spinner_working (p250) outranks osc_title_idle (p200)', () => {
    const screen = '✻ Hatching… (5s\n\n\n\n\n';
    const result = evaluateManifest(claudeCodeManifest, input(screen, '✳ Claude'));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('spinner_working');
  });
});

describe('codex manifest: esc_to_interrupt_working', () => {
  it('matches Esc to interrupt text after prompt marker', () => {
    const screen = '› task\nProcessing...\nEsc to interrupt\n';
    const result = evaluateManifest(codexManifest, input(screen));
    expect(result.state).toBe('working');
    expect(result.matchedRuleId).toBe('esc_to_interrupt_working');
  });
});

describe('codex manifest: codex_idle_prompt', () => {
  it('matches bare › prompt with visibleIdle', () => {
    const screen = 'previous output\n\n› \n\n\n';
    const result = evaluateManifest(codexManifest, input(screen));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBe('codex_idle_prompt');
    expect(result.visibleIdle).toBe(true);
  });
});
