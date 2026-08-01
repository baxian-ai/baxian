import { createHash } from 'node:crypto';
import type {
  AgentConfig,
  AgentRole,
  DispatchPhase,
  TaskState,
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

const PLATFORM_TASK_PHASES = new Set(['develop', 'code', 'review', 'recheck', 'fix', 'post-approve']);
const PHASE_ROLES: Partial<Record<DispatchPhase, AgentRole>> = {
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

function platformDescriptorFields(
  task: TaskState,
  phase: string,
  platform?: PlatformPromptContext,
): string[] {
  if (!PLATFORM_TASK_PHASES.has(phase)) return [];
  const lines: string[] = [];
  if (platform) {
    lines.push(`repo: ${platform.repo}`);
  }
  if (phase === 'develop' || phase === 'code') {
    lines.push(`branch: ${task.branch ?? '<branch>'}`);
    if (task.baseBranch) lines.push(`base: ${task.baseBranch}`);
    if (task.branch) lines.push(`spec-path: ${specPathForBranch(task.branch)}`);
    if (phase === 'code' && task.prNumber !== undefined) lines.push(`pr: ${task.prNumber}`);
  }
  if (phase === 'review' || phase === 'recheck') {
    if (!task.reviewHeadAnchorSha || !task.passToken || !task.failToken) {
      throw new Error(`${phase} prompt for git task ${task.id} requires anchor-sha and a minted pass/fail token pair`);
    }
    lines.push(
      `anchor-sha: ${task.reviewHeadAnchorSha}`,
      `pass-token: ${task.passToken}`,
      `fail-token: ${task.failToken}`,
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
  const expectedRole = PHASE_ROLES[opts.phase as DispatchPhase];
  if (expectedRole !== undefined && opts.agent.role !== expectedRole) {
    throw new Error(`${opts.phase} phase requires a ${expectedRole} agent`);
  }
  const fullPrompt = buildTaskBody({
    task: opts.task,
    phase: opts.phase,
    workdir: opts.workdir,
    signalToken: opts.signalToken,
    imagePaths: opts.imagePaths,
    platform: opts.platform,
    includeTaskContext: opts.includeTaskContext ?? true,
  });
  const bytes = Buffer.byteLength(fullPrompt, 'utf8');
  if (bytes > MAX_PROMPT_BYTES) throw new PromptSizeError(bytes);
  return fullPrompt;
}

export function buildGreetingPrompt(token: string): string {
  return (
    `token: ${token}\n` +
    `Reply with exactly \`[bx:greeting:<token>]\` on its own line, replacing <token> with the token above. ` +
    `Do not use a tool or output anything else.\n`
  );
}

interface TaskBodyArgs {
  task: TaskState;
  phase: string;
  workdir: string;
  signalToken?: string;
  imagePaths?: string[];
  platform?: PlatformPromptContext;
  includeTaskContext: boolean;
}

interface PhasePromptCtx {
  task: TaskState;
}
interface PhasePrompt {
  fields: string[];
  contract: string;
}
type PhasePromptBuilder = (ctx: PhasePromptCtx) => PhasePrompt;

function reviewFields({ task }: PhasePromptCtx, recheck: boolean): PhasePrompt {
  if (!task.reviewHeadAnchorSha || !task.passToken || !task.failToken) {
    throw new Error(`review prompt for git task ${task.id} requires anchor-sha and a minted pass/fail token pair`);
  }
  return {
    fields: [
      `pr: ${task.prNumber ?? '<pr-number>'}`,
      ...(task.phase === 'spec' ? ['stage: spec'] : []),
    ],
    contract:
      `Independently review the complete PR at anchor-sha: diff first, then requirements, tests/checks, ` +
      `and every fully paginated feedback source. ` +
      `${recheck ? 'Verify every prior finding against the replies and current code, then check for new risks. ' : ''}` +
      `${task.phase === 'spec'
        ? 'Review the spec for complete, implementable requirements; implementation is not required yet.'
        : 'Verify claims against the code and report only concrete findings.'}\n` +
      `Publish exactly one platform verdict and verify it landed on anchor-sha:\n` +
      `pass: ${buildReviewTokenLine({
        kind: 'pass',
        anchorSha: task.reviewHeadAnchorSha,
        token: task.passToken,
      })}\n` +
      `fail: ${buildReviewTokenLine({
        kind: 'fail',
        anchorSha: task.reviewHeadAnchorSha,
        token: task.failToken,
      })}\n` +
      `There is no pane completion signal for a review verdict.`,
  };
}

const PHASE_PROMPT_BUILDERS: Record<DispatchPhase, PhasePromptBuilder> = {
  merge: () => ({
    fields: [],
    contract: 'Baxian owns merge execution. Do not merge or change the task from this prompt.',
  }),
  develop: ({ task }) => ({
    fields: [],
    contract:
      `Choose one route: implement, test, commit, push, publish the PR, then emit ` +
      `\`[bx:pr-created:<pr>:<actor>:<token>]\`; or write a complete implementable spec to spec-path without ` +
      `overwriting an unrelated file, commit, push, publish the PR, then emit ` +
      `\`[bx:spec-done:<pr>:<actor>:<token>]\`. Never merge or leave workdir/branch ` +
      `${JSON.stringify(task.branch ?? '<branch>')}.`,
  }),
  code: () => ({
    fields: [],
    contract:
      `Read the approved spec-path, implement it completely, test, commit, push, and update the bound PR via ` +
      `platform publish. Then emit \`[bx:pr-created:<pr>:<actor>:<token>]\` exactly once. ` +
      `Never merge or change branch/workdir.`,
  }),
  fix: ({ task }) => ({
    fields: [
      `pr: ${task.prNumber ?? '<pr-number>'}`,
      `branch: ${task.branch ?? '<branch>'}`,
      ...(task.phase === 'spec' ? ['stage: spec'] : []),
    ],
    contract:
      `Read every fully paginated feedback source and judge/reply to every item. ` +
      `${task.phase === 'spec' ? 'Apply accepted findings to the reviewed spec.' : 'Apply accepted findings to code and tests.'} ` +
      `Commit and push any file changes. When all current feedback is handled, emit ` +
      `\`[bx:pr-fixed:<token>]\` exactly once, including when replies required no file change.`,
  }),
  'post-approve': ({ task }) => ({
    fields: [`pr: ${task.prNumber ?? '<pr-number>'}`],
    contract:
      `Re-read every fully paginated feedback source and handle all current items. If any file changes, commit and ` +
      `push, then stop without a completion signal so Baxian can recheck. If no file change is needed, re-fetch once ` +
      `more; only when clean emit \`[bx:pr-merge-ready:<token>]\` exactly once. Never merge.`,
  }),
  review: (ctx) => reviewFields(ctx, false),
  recheck: (ctx) => reviewFields(ctx, true),
};

function platformPromptForPhase(
  phase: string,
  prompts: PlatformAgentPrompts,
  includeCommon: boolean,
): string {
  const phasePrompt =
    phase === 'develop' || phase === 'code'
      ? prompts.publish
      : phase === 'fix' || phase === 'post-approve'
        ? prompts.feedback
        : phase === 'review' || phase === 'recheck'
          ? prompts.review
          : '';
  return [includeCommon ? prompts.common : '', phasePrompt].filter(Boolean).join('\n');
}

function buildTaskBody(args: TaskBodyArgs): string {
  const {
    task, phase, workdir, signalToken,
    imagePaths, platform, includeTaskContext,
  } = args;
  if (phase === 'post-approve' && !signalToken) {
    throw new Error('post-approve prompt requires signalToken');
  }
  if (
    (phase === 'develop'
      || phase === 'code'
      || phase === 'review'
      || phase === 'recheck'
      || phase === 'fix')
    && !signalToken
  ) {
    throw new Error(`${phase} prompt requires signalToken`);
  }
  const phaseBuilder = (PHASE_PROMPT_BUILDERS as Record<string, PhasePromptBuilder>)[phase];
  if (!phaseBuilder) {
    throw new Error(`buildTaskBody: no prompt builder registered for phase "${phase}"`);
  }
  const { fields, contract } = phaseBuilder({ task });

  const descriptor = [
    `task: ${task.id}`,
    `phase: ${phase}`,
    `workdir: ${workdir}`,
    ...platformDescriptorFields(task, phase, platform),
    ...fields,
    ...(signalToken ? [`token: ${signalToken}`] : []),
  ].join('\n');
  const taskBlock = includeTaskContext
    ? task.description
      ? `\n\ntitle: ${task.title}\n\n${task.description}`
      : `\n\ntitle: ${task.title}`
    : '';
  const imagesBlock = includeTaskContext && imagePaths && imagePaths.length > 0
    ? '\n\nimages:\n' + imagePaths.map(p => `- ${p}`).join('\n')
    : '';
  const common =
    `Baxian keeps this Agent+Task context across phases and owns routing/merge. Stay in workdir on its branch, follow ` +
    `repository rules, and use normal engineering judgment.\n` +
    `Emit each [bx:...] marker as assistant text alone on its own line, with placeholders replaced, only after its ` +
    `conditions hold. For the nth paused human question emit \`[bx:need-input:<token>:<n>]\`; after its answer first ` +
    `emit \`[bx:input-received:<token>:<n>]\`.`;
  const platformPrompt = platform && PLATFORM_TASK_PHASES.has(phase)
    ? platformPromptForPhase(phase, platform.prompts, includeTaskContext)
    : '';
  const platformBlock = platformPrompt
    ? `\n\nPlatform workflow:\n${platformPrompt}`
    : '';
  const protocolBlock = includeTaskContext ? `\n\nProtocol:\n${common}` : '';
  const body =
    `${descriptor}${taskBlock}${imagesBlock}\n\nCurrent phase contract:\n${contract}` +
    `${platformBlock}${protocolBlock}\n`;
  if (signalToken) {
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
  return body;
}

export interface PostMergeCleanupContext {
  taskId: string;
  branch: string;
}
