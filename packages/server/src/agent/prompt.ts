import { AGENT_PHASES, type AgentConfig, type AgentRole, type AgentRuntime, type DispatchPhase, type TaskState } from '../shared/index.js';
import type { SkillRegistry } from '../skill/registry.js';
import { scanNeedInputSignals, scanPhaseSignals } from './phase-signal.js';
import { visibleText } from './vt-visible-text.js';

export const MAX_PROMPT_BYTES = 80 * 1024;
export const MAX_PROMPT_BYTES_ROUTE_LIMIT = MAX_PROMPT_BYTES - 1024;

export class PromptSizeError extends Error {
  constructor(public readonly bytes: number) {
    super(
      `prompt size ${bytes} bytes exceeds ${MAX_PROMPT_BYTES} limit; ` +
      `reduce task description or remove some skills from AGENT_PHASES`,
    );
    this.name = 'PromptSizeError';
  }
}

export class RequiredSkillsMissingError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      `required skill(s) not found in registry: ${missing.join(', ')}. ` +
      `The skills directory may be missing or failed to load.`,
    );
    this.name = 'RequiredSkillsMissingError';
  }
}

const SKILL_INVOKE_SIGIL: Record<AgentRuntime, string> = {
  'claude-code': '/',
  codex: '$',
  opencode: '/',
  qodercli: '/',
};

export interface PlatformCliDescriptor {
  tool: string;
  host: string;
  repo: string;
  repoEncoded: string;
  notes?: string;
}

const CLI_NOTES_MAX_BYTES = 512;
const GIT_PLATFORM_PHASES = new Set(['develop', 'code', 'review', 'recheck', 'fix', 'post-approve']);

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let out = '';
  for (const ch of value) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

function gitDescriptorFields(
  task: TaskState,
  phase: string,
  platformCli?: PlatformCliDescriptor,
): string[] {
  if (!GIT_PLATFORM_PHASES.has(phase)) return [];
  const lines: string[] = [];
  if (platformCli) {
    lines.push(
      `cli: ${platformCli.tool}`,
      `cli-host: ${platformCli.host}`,
      `cli-repo: ${platformCli.repo}`,
      `cli-repo-encoded: ${platformCli.repoEncoded}`,
    );
    if (platformCli.notes !== undefined) {
      lines.push(`cli-notes: ${truncateUtf8(platformCli.notes, CLI_NOTES_MAX_BYTES)}`);
    }
  }
  if (phase === 'develop' || phase === 'code') {
    lines.push(`branch: ${task.branch ?? '<branch>'}`);
    if (task.baseBranch) lines.push(`base: ${task.baseBranch}`);
    if (phase === 'code' && task.prNumber !== undefined) lines.push(`pr: ${task.prNumber}`);
  }
  if (phase === 'review' || phase === 'recheck') {
    if (!task.passToken || !task.failToken) {
      throw new Error(`${phase} prompt for git task ${task.id} requires a minted pass/fail token pair`);
    }
    lines.push(`pass-token: ${task.passToken}`, `fail-token: ${task.failToken}`);
  }
  return lines;
}

function phasePrimarySkill(role: AgentRole, phase: string): string | undefined {
  const skills = AGENT_PHASES[role]?.[phase as keyof (typeof AGENT_PHASES)[AgentRole]]?.skills ?? [];
  return skills[0];
}

export interface BuildPromptOpts {
  task: TaskState;
  phase: string;
  agent: AgentConfig;
  workdir: string;
  skillRegistry: SkillRegistry;
  signalToken?: string;
  imagePaths?: string[];
  platformCli?: PlatformCliDescriptor;
}

export function buildPromptInline(opts: BuildPromptOpts): string {
  const required = [
    ...(AGENT_PHASES[opts.agent.role]?.[opts.phase]?.skills ?? []),
    ...(opts.signalToken ? ['baxian-signals'] : []),
  ];
  const missing = required.filter(name => !opts.skillRegistry.has(name));
  if (missing.length > 0) throw new RequiredSkillsMissingError(missing);
  const taskBody = buildTaskBody({
    task: opts.task,
    phase: opts.phase,
    workdir: opts.workdir,
    signalToken: opts.signalToken,
    imagePaths: opts.imagePaths,
    platformCli: opts.platformCli,
  });
  const primary = phasePrimarySkill(opts.agent.role, opts.phase);
  const slotSkill = primary ?? (opts.signalToken ? 'baxian-signals' : undefined);
  const invokeLine = slotSkill
    ? `${SKILL_INVOKE_SIGIL[opts.agent.runtime]}${slotSkill}\n`
    : '';
  const fullPrompt = invokeLine + taskBody;
  const bytes = Buffer.byteLength(fullPrompt, 'utf8');
  if (bytes > MAX_PROMPT_BYTES) throw new PromptSizeError(bytes);
  return fullPrompt;
}

export function buildGreetingPrompt(token: string, runtime: AgentRuntime): string {
  return `${SKILL_INVOKE_SIGIL[runtime]}baxian-greeting\ntoken: ${token}\n`;
}

interface TaskBodyArgs {
  task: TaskState;
  phase: string;
  workdir: string;
  signalToken?: string;
  imagePaths?: string[];
  platformCli?: PlatformCliDescriptor;
}

interface PhasePromptCtx {
  task: TaskState;
}
interface PhasePrompt {
  fields: string[];
  blocks?: string[];
}
type PhasePromptBuilder = (ctx: PhasePromptCtx) => PhasePrompt;

function reviewFields({ task }: PhasePromptCtx): PhasePrompt {
  return {
    fields: [
      `pr: ${task.prNumber ?? '<pr-number>'}`,
      ...(task.reviewHeadAnchorSha ? [`anchor-sha: ${task.reviewHeadAnchorSha}`] : []),
      ...(task.phase === 'spec' ? ['stage: spec'] : []),
    ],
  };
}

const PHASE_PROMPT_BUILDERS: Record<DispatchPhase, PhasePromptBuilder> = {
  merge: () => ({ fields: [] }),
  develop: () => ({ fields: [] }),
  code: () => ({ fields: [] }),
  fix: ({ task }) => ({
    fields: [
      `pr: ${task.prNumber ?? '<pr-number>'}`,
      `branch: ${task.branch ?? '<branch>'}`,
      ...(task.phase === 'spec' ? ['stage: spec'] : []),
    ],
  }),
  'post-approve': ({ task }) => ({
    fields: [`pr: ${task.prNumber ?? '<pr-number>'}`],
  }),
  review: (ctx) => reviewFields(ctx),
  recheck: (ctx) => reviewFields(ctx),
};

function buildTaskBody(args: TaskBodyArgs): string {
  const {
    task, phase, workdir, signalToken,
    imagePaths, platformCli,
  } = args;
  if (phase === 'post-approve' && !signalToken) {
    throw new Error('post-approve prompt requires signalToken');
  }
  if ((phase === 'code' || phase === 'review' || phase === 'recheck' || phase === 'fix') && !signalToken) {
    throw new Error(`${phase} prompt requires signalToken`);
  }
  const phaseBuilder = (PHASE_PROMPT_BUILDERS as Record<string, PhasePromptBuilder>)[phase];
  if (!phaseBuilder) {
    throw new Error(`buildTaskBody: no prompt builder registered for phase "${phase}"`);
  }
  const { fields, blocks } = phaseBuilder({ task });

  const descriptor = [
    `phase: ${phase}`,
    `workdir: ${workdir}`,
    ...gitDescriptorFields(task, phase, platformCli),
    ...fields,
    ...(signalToken ? [`token: ${signalToken}`] : []),
  ].join('\n');
  const titleAndBody = task.description
    ? `title: ${task.title}\n\n${task.description}`
    : `title: ${task.title}`;
  const imagesBlock = imagePaths && imagePaths.length > 0
    ? '\n\nimages:\n' + imagePaths.map(p => `- ${p}`).join('\n')
    : '';
  const injected = blocks && blocks.length > 0 ? '\n\n' + blocks.join('\n') : '';
  const body = `${descriptor}\n\n${titleAndBody}${imagesBlock}${injected}\n`;
  if (signalToken) {
    // 别删 raw 臂：藏在控制串里的 marker 不上屏，TUI 却会原样回显出去。
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
