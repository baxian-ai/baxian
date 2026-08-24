import { describe, expect, it } from 'vitest';
import { classifyScreen, manifests } from '../../../src/agent/detect/classify.js';

describe('manifests', () => {
  it('loads one manifest per runtime keyed by runtime kind', () => {
    expect(Object.keys(manifests).sort()).toEqual(['claude-code', 'codex', 'opencode', 'qodercli']);
    for (const [runtime, manifest] of Object.entries(manifests)) {
      expect(manifest.id, `manifest id for ${runtime}`).toBe(runtime);
      expect(manifest.rules.length).toBeGreaterThan(0);
    }
  });
});

describe('classifyScreen', () => {
  it('reports working for a claude spinner tail', () => {
    const d = classifyScreen('claude-code', '✻ Pondering… (3s · esc to interrupt)');
    expect(d.state).toBe('working');
    expect(d.matchedRuleId).toBe('live_turn_working');
  });

  it('reports idle with a matched rule for the claude boxed composer prompt', () => {
    const d = classifyScreen('claude-code', 'some transcript\n────────\n❯ \n────────\n');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBe('live_prompt_box');
  });

  it('reports default idle for a bare unboxed ❯ prompt (herdr: live_prompt_box needs the box)', () => {
    const d = classifyScreen('claude-code', 'some transcript\n❯ \n');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBeUndefined();
  });

  it('returns default idle without a matched rule for an empty screen', () => {
    const d = classifyScreen('claude-code', '');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBeUndefined();
  });

  it('reports pending for the claude blocked form footer', () => {
    const d = classifyScreen('claude-code', ' Enter to confirm · Esc to cancel\n');
    expect(d.state).toBe('pending');
    expect(d.matchedRuleId).toBe('live_blocked_form');
  });

  it('picks the highest-priority match with no arbitration: working osc title beats idle screen (herdr)', () => {
    const d = classifyScreen('claude-code', 'done\n────────\n❯ \n────────\n', '⠧ thinking');
    expect(d.state).toBe('working');
    expect(d.matchedRuleId).toBe('osc_title_working');
  });

  it('reports working from the osc title alone when the screen shows nothing', () => {
    const d = classifyScreen('claude-code', '', '⠧ thinking');
    expect(d.state).toBe('working');
    expect(d.matchedRuleId).toBe('osc_title_working');
  });

  it('reports working for the codex Working line after the prompt marker', () => {
    const d = classifyScreen('codex', '› do the thing\n\n• Working (4s • esc to interrupt)\n');
    expect(d.state).toBe('working');
  });

  it('reports pending for the codex strong blocker', () => {
    const d = classifyScreen('codex', '› run it\n\nAllow command?\npress enter to confirm or esc to cancel\n');
    expect(d.state).toBe('pending');
    expect(d.visibleBlocker).toBe(true);
  });

  it('reports working for the opencode progress bar', () => {
    const d = classifyScreen('opencode', '■■■■■■ building\n');
    expect(d.state).toBe('working');
  });

  it('reports default idle for the qodercli composer (herdr: no idle rules, no-match falls back to idle)', () => {
    const d = classifyScreen('qodercli', 'Type your message or @path/to/file\n');
    expect(d.state).toBe('idle');
    expect(d.matchedRuleId).toBeUndefined();
  });
});
