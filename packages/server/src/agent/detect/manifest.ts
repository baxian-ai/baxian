import type { Gate } from './gate.js';
import { evaluateGate } from './gate.js';
import { extractRegion, type DetectionInput } from './region.js';

export type DetectedState = 'idle' | 'working' | 'pending' | 'unknown';

interface ManifestRule extends Gate {
  id: string;
  state: DetectedState;
  priority: number;
  region: string;
  visibleBlocker?: boolean;
  visibleIdle?: boolean;
  visibleWorking?: boolean;
  skipStateUpdate?: boolean;
}

export interface AgentManifest {
  id: string;
  rules: ManifestRule[];
}

export interface ManifestDetection {
  state: DetectedState;
  matchedRuleId?: string;
  visibleBlocker: boolean;
  visibleIdle: boolean;
  visibleWorking: boolean;
  skipStateUpdate: boolean;
}

export function evaluateManifest(
  manifest: AgentManifest,
  input: DetectionInput,
): ManifestDetection {
  let matched: ManifestRule | undefined;
  let bestScreenBlocker: ManifestRule | undefined;
  let bestScreenEvidence: ManifestRule | undefined;
  let bestScreenSkip: ManifestRule | undefined;

  for (const rule of manifest.rules) {
    const regionText = extractRegion(input, rule.region);
    if (!evaluateGate(rule, regionText)) continue;

    if (!matched || rule.priority > matched.priority) {
      matched = rule;
    }
    if (rule.region !== 'oscTitle') {
      if (rule.skipStateUpdate) {
        if (!bestScreenSkip || rule.priority > bestScreenSkip.priority) {
          bestScreenSkip = rule;
        }
      } else {
        if (rule.visibleBlocker && rule.state === 'pending') {
          if (!bestScreenBlocker || rule.priority > bestScreenBlocker.priority) {
            bestScreenBlocker = rule;
          }
        }
        if ((rule.visibleWorking && rule.state === 'working') || (rule.visibleIdle && rule.state === 'idle')) {
          if (!bestScreenEvidence || rule.priority > bestScreenEvidence.priority) {
            bestScreenEvidence = rule;
          }
        }
      }
    }
  }

  if (matched && matched.region === 'oscTitle') {
    if (bestScreenBlocker && bestScreenSkip && bestScreenBlocker.priority >= bestScreenSkip.priority) {
      matched = bestScreenBlocker;
    } else if (bestScreenSkip) {
      matched = bestScreenSkip;
    } else if (matched.state === 'working' && bestScreenBlocker && bestScreenBlocker.priority >= 900) {
      matched = bestScreenBlocker;
    } else if (matched.state === 'working' && bestScreenEvidence && bestScreenEvidence.state === 'idle') {
      matched = bestScreenEvidence;
    } else if (matched.state === 'pending') {
      if (bestScreenBlocker) {
        matched = bestScreenBlocker;
      } else if (bestScreenEvidence) {
        matched = bestScreenEvidence;
      }
    }
  }

  if (!matched) {
    return {
      state: 'idle',
      visibleBlocker: false,
      visibleIdle: false,
      visibleWorking: false,
      skipStateUpdate: false,
    };
  }

  return {
    state: matched.state,
    matchedRuleId: matched.id,
    visibleBlocker: !!(matched.visibleBlocker && matched.state === 'pending'),
    visibleIdle: !!(matched.visibleIdle && matched.state === 'idle'),
    visibleWorking: !!(matched.visibleWorking && matched.state === 'working'),
    skipStateUpdate: !!matched.skipStateUpdate,
  };
}
