import { describe, expect, it } from 'vitest';
import {
  buildGreetingPrompt,
  buildPromptInline,
} from '../src/agent/prompt.js';
import {
  PHASE_SIGNAL_KINDS,
  scanNeedInputSignals,
  scanPhaseSignals,
} from '../src/agent/phase-signal.js';
import { makeAgent, makeTask } from './helpers/fixtures.js';

const TOKEN = 'signal123456';

function phasePrompt(phase: 'develop' | 'code' | 'fix' | 'post-approve'): string {
  return buildPromptInline({
    task: makeTask({
      signalToken: TOKEN,
      prNumber: 42,
      ...(phase === 'fix' ? { status: 'fixing' as const } : {}),
      ...(phase === 'post-approve' ? { status: 'approved' as const } : {}),
    }),
    phase,
    agent: makeAgent(),
    workdir: '/tmp/repo',
    signalToken: TOKEN,
  });
}

describe('inline workflow wire protocol', () => {
  it('covers every task completion route with a server-watched kind', () => {
    const routes = [
      { phase: 'develop' as const, kind: 'pr-created' },
      { phase: 'develop' as const, kind: 'spec-done' },
      { phase: 'code' as const, kind: 'pr-created' },
      { phase: 'fix' as const, kind: 'pr-fixed' },
      { phase: 'post-approve' as const, kind: 'pr-merge-ready' },
    ];

    for (const { phase, kind } of routes) {
      expect(phasePrompt(phase)).toContain(`[bx:${kind}:`);
      expect(PHASE_SIGNAL_KINDS).toContain(kind);
    }
  });

  it('keeps completion examples unfilled, so injecting a prompt cannot advance the task', () => {
    for (const phase of ['develop', 'code', 'fix', 'post-approve'] as const) {
      expect(scanPhaseSignals(phasePrompt(phase))).toEqual([]);
    }
  });

  it('defines both need-input forms without firing either scanner', () => {
    const result = phasePrompt('develop');

    expect(result).toContain('[bx:need-input:<token>:<n>]');
    expect(result).toContain('[bx:input-received:<token>:<n>]');
    expect(scanNeedInputSignals(result)).toEqual([]);
  });

  it('keeps the answer acknowledgement ordering and the repository-rules clause', () => {
    expect(phasePrompt('develop'))
      .toMatch(/\[bx:input-received:<token>:<n>\]` before anything else/);
    expect(phasePrompt('develop')).toContain('follow repository rules');
  });

  it('keeps the startup handshake unfilled so prompt echo cannot satisfy it', () => {
    const result = buildGreetingPrompt(TOKEN);

    expect(result).toContain('[bx:greeting:<token>]');
    expect(scanPhaseSignals(result)).toEqual([]);
  });
});
