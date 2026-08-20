import { createHash } from 'node:crypto';
import {
  isSpecStagePhase,
  type AgentConfig,
  type AgentRole,
  type DispatchPhase,
  type TaskState,
} from '../shared/index.js';
import { buildReviewTokenLine } from '../platform/markers.js';
import type { PlatformAgentPrompts, PlatformPromptContext } from '../platform/types.js';
import { scanNeedInputSignals, scanPhaseSignals } from './phase-signal.js';
import { visibleText } from './vt-visible-text.js';

export const MAX_PROMPT_BYTES = 80 * 1024;
export const MAX_PROMPT_BYTES_ROUTE_LIMIT = MAX_PROMPT_BYTES - 1024;

export class PromptSizeError extends Error {
  constructor(public readonly bytes: number) {
    super(
      `prompt size ${bytes} bytes exceeds ${MAX_PROMPT_BYTES} limit; ` +
      `reduce the task description or platform workflow instructions`,
    );
    this.name = 'PromptSizeError';
  }
}

const PHASE_ROLES: Record<DispatchPhase, AgentRole> = {
  develop: 'dev',
  code: 'dev',
  fix: 'dev',
  'post-approve': 'dev',
  review: 'qa',
  recheck: 'qa',
};

export function specPathForBranch(branch: string): string {
  const slug = branch
    .replace(/[A-Z]/g, ch => ch.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const hash = createHash('sha256').update(branch).digest('hex').slice(0, 16);
  return `docs/specs/${slug}-${hash}.md`;
}

function taskScopedFields(task: TaskState, role: AgentRole, platform?: PlatformPromptContext): string[] {
  const lines: string[] = [];
  if (platform) lines.push(`repo: ${platform.repo}`);
  if (role === 'dev') {
    lines.push(`branch: ${task.branch ?? '<branch>'}`);
    if (task.baseBranch) lines.push(`base: ${task.baseBranch}`);
    if (task.branch) lines.push(`spec-path: ${specPathForBranch(task.branch)}`);
  }
  return lines;
}

function roundFields(task: TaskState, phase: DispatchPhase): string[] {
  const lines: string[] = [];
  if (task.prNumber !== undefined) lines.push(`pr: ${task.prNumber}`);
  if (isSpecStagePhase(task.phase)) lines.push('stage: spec');
  if (phase === 'review' || phase === 'recheck') {
    if (!task.reviewHeadAnchorSha || !task.passToken || !task.failToken) {
      throw new Error(`${phase} prompt for git task ${task.id} requires anchor-sha and a minted pass/fail token pair`);
    }
    lines.push(
      `anchor-sha: ${task.reviewHeadAnchorSha}`,
      `pass: ${buildReviewTokenLine({ kind: 'pass', anchorSha: task.reviewHeadAnchorSha, token: task.passToken })}`,
      `fail: ${buildReviewTokenLine({ kind: 'fail', anchorSha: task.reviewHeadAnchorSha, token: task.failToken })}`,
    );
  }
  return lines;
}

export interface BuildPromptOpts {
  task: TaskState;
  phase: string;
  agent: AgentConfig;
  workdir: string;
  signalToken?: string;
  imagePaths?: string[];
  platform?: PlatformPromptContext;
  includeTaskContext?: boolean;
}

export function buildPromptInline(opts: BuildPromptOpts): string {
  const role = (PHASE_ROLES as Record<string, AgentRole | undefined>)[opts.phase];
  if (role === undefined) throw new Error(`buildPromptInline: no agent contract for phase "${opts.phase}"`);
  if (opts.agent.role !== role) throw new Error(`${opts.phase} phase requires a ${role} agent`);
  if (!opts.signalToken) throw new Error(`${opts.phase} prompt requires signalToken`);
  const phase = opts.phase as DispatchPhase;
  const { task, signalToken } = opts;
  const includeTaskContext = opts.includeTaskContext ?? true;

  const descriptor = [
    `task: ${task.id}`,
    `phase: ${phase}`,
    ...(includeTaskContext ? [`workdir: ${opts.workdir}`, ...taskScopedFields(task, role, opts.platform)] : []),
    ...roundFields(task, phase),
    `token: ${signalToken}`,
  ].join('\n');
  const body = includeTaskContext
    ? `${descriptor}${taskContextBlocks(task, opts.imagePaths)}\n\n${roleContext(role, opts.platform)}\n`
    : `${descriptor}\n`;
  assertNoFilledSignal(body, phase, signalToken);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_PROMPT_BYTES) throw new PromptSizeError(bytes);
  return body;
}

export function buildGreetingPrompt(token: string): string {
  return (
    `token: ${token}\n` +
    `Reply with exactly \`[bx:greeting:<token>]\` on its own line, replacing <token> with the token above. ` +
    `Do not use a tool or output anything else.\n`
  );
}

const ROLE_CONTRACTS: Record<AgentRole, string> = {
  dev:
    `Task contract (dev; later prompts for this task carry only the header lines):\n` +
    `develop: Choose one route: implement, test, commit, push, publish the PR, then emit ` +
    `\`[bx:pr-created:<pr>:<token>]\`; or write a complete implementable spec to spec-path without ` +
    `overwriting an unrelated file, commit, push, publish the PR, then emit \`[bx:spec-done:<pr>:<token>]\`.\n` +
    `fix: Read every fully paginated feedback source and judge/reply to every item. Apply accepted findings to ` +
    `code and tests, or to the reviewed spec while \`stage: spec\`. Commit and push any file changes. When all ` +
    `current feedback is handled, emit \`[bx:pr-fixed:<token>]\` exactly once, including when replies required ` +
    `no file change.\n` +
    `code: Read the approved spec-path, implement it completely, test, commit, push, and update the bound PR via ` +
    `platform publish. Then emit \`[bx:pr-created:<pr>:<token>]\` exactly once.\n` +
    `post-approve: Re-read every fully paginated feedback source and handle all current items. If any file ` +
    `changes, commit and push, then stop without a completion signal so Baxian can recheck. If no file change is ` +
    `needed, re-fetch once more; only when clean emit \`[bx:pr-merge-ready:<token>]\` exactly once.\n` +
    `Never merge or leave workdir/branch.`,
  qa:
    `Task contract (qa; later prompts for this task carry only the header lines):\n` +
    `review: Independently review the complete PR at anchor-sha: diff first, then requirements, tests/checks, ` +
    `and every fully paginated feedback source. Verify claims against the code and report only concrete ` +
    `findings; while \`stage: spec\`, review the spec for complete, implementable requirements and do not ` +
    `require implementation yet.\n` +
    `recheck: Everything under review applies again on this round's anchor-sha; additionally verify every prior ` +
    `finding against the replies and current code, then check for new risks.\n` +
    `Publish exactly one platform verdict using this round's pass or fail line and verify it landed on ` +
    `anchor-sha. There is no pane completion signal for a review verdict.`,
};

const PROTOCOL =
  `Baxian keeps this Agent+Task context across phases and owns routing/merge. Stay in workdir on its branch, follow ` +
  `repository rules, and use normal engineering judgment.\n` +
  `Emit each [bx:...] marker as assistant text alone on its own line, with placeholders replaced, only after its ` +
  `conditions hold. For the nth paused human question emit \`[bx:need-input:<token>:<n>]\`; after its answer first ` +
  `emit \`[bx:input-received:<token>:<n>]\`.`;

function platformPromptForRole(role: AgentRole, prompts: PlatformAgentPrompts): string {
  const slices = role === 'dev'
    ? [`publish: ${prompts.publish}`, `feedback: ${prompts.feedback}`]
    : [`review: ${prompts.review}`];
  return [prompts.common, ...slices].join('\n');
}

function taskContextBlocks(task: TaskState, imagePaths?: string[]): string {
  const taskBlock = task.description
    ? `\n\ntitle: ${task.title}\n\n${task.description}`
    : `\n\ntitle: ${task.title}`;
  const imagesBlock = imagePaths && imagePaths.length > 0
    ? '\n\nimages:\n' + imagePaths.map(p => `- ${p}`).join('\n')
    : '';
  return `${taskBlock}${imagesBlock}`;
}

function roleContext(role: AgentRole, platform?: PlatformPromptContext): string {
  const platformBlock = platform
    ? `\n\nPlatform workflow:\n${platformPromptForRole(role, platform.prompts)}`
    : '';
  return `${ROLE_CONTRACTS[role]}${platformBlock}\n\nProtocol:\n${PROTOCOL}`;
}

function assertNoFilledSignal(body: string, phase: DispatchPhase, signalToken: string): void {
  for (const arm of [body, visibleText(body)]) {
    const leaked = scanPhaseSignals(arm).find(s => s.token === signalToken);
    if (leaked) {
      throw new Error(`${phase} prompt must not contain a filled ${leaked.kind} signal literal`);
    }
    if (scanNeedInputSignals(arm).some(s => s.token === signalToken)) {
      throw new Error(`${phase} prompt must not contain a filled need-input signal literal`);
    }
  }
}
