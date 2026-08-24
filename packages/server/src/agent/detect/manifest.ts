import type { Gate } from './gate.js';
import { compileGate, evaluateGate } from './gate.js';
import { extractRegion, isKnownRegion, type DetectionInput } from './region.js';

export type AgentRuntimeKind = 'claude-code' | 'codex' | 'opencode' | 'qodercli';

export type DetectedState = 'idle' | 'working' | 'pending' | 'unknown';

export interface ManifestRule extends Gate {
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

export function compileManifest(manifest: AgentManifest): AgentManifest {
  for (const rule of manifest.rules) {
    const where = `manifest ${manifest.id} rule ${rule.id}`;
    if (!isKnownRegion(rule.region)) throw new Error(`${where} uses unknown region: ${rule.region}`);
    try {
      compileGate(rule);
    } catch (err) {
      throw new Error(`${where} has an uncompilable pattern: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return manifest;
}

const rulesByPriority = new WeakMap<AgentManifest, ManifestRule[]>();

// 稳定降序 = 上游"取最高优先级、同分取先出现者",于是首个命中即最终结果
function orderedRules(manifest: AgentManifest): ManifestRule[] {
  let ordered = rulesByPriority.get(manifest);
  if (!ordered) {
    ordered = [...manifest.rules].sort((a, b) => b.priority - a.priority);
    rulesByPriority.set(manifest, ordered);
  }
  return ordered;
}

export function evaluateManifest(
  manifest: AgentManifest,
  input: DetectionInput,
): ManifestDetection {
  for (const rule of orderedRules(manifest)) {
    if (!evaluateGate(rule, extractRegion(input, rule.region))) continue;
    return {
      state: rule.state,
      matchedRuleId: rule.id,
      visibleBlocker: !!(rule.visibleBlocker && rule.state === 'pending'),
      visibleIdle: !!(rule.visibleIdle && rule.state === 'idle'),
      visibleWorking: !!(rule.visibleWorking && rule.state === 'working'),
      skipStateUpdate: !!rule.skipStateUpdate,
    };
  }

  return {
    state: 'idle',
    visibleBlocker: false,
    visibleIdle: false,
    visibleWorking: false,
    skipStateUpdate: false,
  };
}
