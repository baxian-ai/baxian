import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compileManifest,
  evaluateManifest,
  type AgentManifest,
  type AgentRuntimeKind,
  type ManifestDetection,
} from './manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadManifests(): Record<AgentRuntimeKind, AgentManifest> {
  const dir = join(__dirname, 'manifests');
  const read = (name: string): AgentManifest =>
    compileManifest(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf-8')) as AgentManifest);
  return {
    'claude-code': read('claude-code'),
    codex: read('codex'),
    opencode: read('opencode'),
    qodercli: read('qodercli'),
  };
}

export const manifests = loadManifests();

export function classifyScreen(
  runtime: AgentRuntimeKind,
  screen: string,
  oscTitle = '',
  oscProgress = '',
): ManifestDetection {
  return evaluateManifest(manifests[runtime], { screen, oscTitle, oscProgress });
}

// 门控策略按 manifest rule id 取信,集中放在规则本体旁边,同步性由 detect 测试守护
export const MENU_RULE_IDS: Record<AgentRuntimeKind, ReadonlySet<string>> = {
  'claude-code': new Set(['live_blocked_form', 'dynamic_workflow_prompt', 'model_picker_menu']),
  codex: new Set(),
  opencode: new Set(),
  qodercli: new Set(),
};

// 只有 claude 的 ✳ 标题是稳定 idle 契约,其余 runtime 的标题不足以判就绪
const TITLE_IDLE_TRUSTED: Record<AgentRuntimeKind, boolean> = {
  'claude-code': true,
  codex: false,
  opencode: false,
  qodercli: false,
};

export function isMenuRule(runtime: AgentRuntimeKind, ruleId: string | undefined): boolean {
  return ruleId !== undefined && MENU_RULE_IDS[runtime].has(ruleId);
}

export function isTrustedIdleRule(runtime: AgentRuntimeKind, ruleId: string | undefined): boolean {
  if (ruleId === undefined) return false;
  return ruleId !== 'osc_title_idle' || TITLE_IDLE_TRUSTED[runtime];
}
