import { AGENT_PHASES, type AgentConfig, type AgentRole, type AgentRuntime, type DispatchPhase, type ReviewContentFileRef, type TaskState } from '../shared/index.js';
import type { SkillRegistry } from '../skill/registry.js';
import { scanPhaseSignals } from './phase-signal.js';

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
};

function phasePrimarySkill(role: AgentRole, phase: string): string | undefined {
  const skills = AGENT_PHASES[role]?.[phase as keyof (typeof AGENT_PHASES)[AgentRole]]?.skills ?? [];
  return skills[0];
}

export interface BuildPromptOpts {
  task: TaskState;
  phase: string;
  agent: AgentConfig;
  worktreePath: string;
  skillRegistry: SkillRegistry;
  signalToken?: string;
  postApproveRedispatchCount?: number;
  currentSpecRound?: number;
  imagePaths?: string[];
  serverContent?: string;
  serverContentFile?: ReviewContentFileRef;
  serverDiffstat?: string;
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorFindingsFile?: ReviewContentFileRef;
  serverPriorResponse?: string;
  serverPriorResponseFile?: ReviewContentFileRef;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  hasQaPartner?: boolean;
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
    worktreePath: opts.worktreePath,
    signalToken: opts.signalToken,
    postApproveRedispatchCount: opts.postApproveRedispatchCount,
    currentSpecRound: opts.currentSpecRound,
    imagePaths: opts.imagePaths,
    serverContent: opts.serverContent,
    serverContentFile: opts.serverContentFile,
    serverDiffstat: opts.serverDiffstat,
    serverBatch: opts.serverBatch,
    serverPriorFindings: opts.serverPriorFindings,
    serverPriorFindingsFile: opts.serverPriorFindingsFile,
    serverPriorResponse: opts.serverPriorResponse,
    serverPriorResponseFile: opts.serverPriorResponseFile,
    serverAfterDone: opts.serverAfterDone,
    hasQaPartner: opts.hasQaPartner,
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
  worktreePath: string;
  signalToken?: string;
  postApproveRedispatchCount?: number;
  currentSpecRound?: number;
  imagePaths?: string[];
  serverContent?: string;
  serverContentFile?: ReviewContentFileRef;
  serverDiffstat?: string;
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorFindingsFile?: ReviewContentFileRef;
  serverPriorResponse?: string;
  serverPriorResponseFile?: ReviewContentFileRef;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  hasQaPartner?: boolean;
}

interface PhasePromptCtx {
  task: TaskState;
  signalToken?: string;
  currentSpecRound?: number;
  postApproveRedispatchCount?: number;
  serverContent?: string;
  serverContentFile?: ReviewContentFileRef;
  serverDiffstat?: string;
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorFindingsFile?: ReviewContentFileRef;
  serverPriorResponse?: string;
  serverPriorResponseFile?: ReviewContentFileRef;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  hasQaPartner?: boolean;
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
    ],
  };
}

function fileField(name: string, ref: ReviewContentFileRef): string {
  return `${name}: ${ref.path} (${Math.max(1, Math.round(ref.bytes / 1024))}KB)`;
}

const PHASE_PROMPT_BUILDERS: Record<DispatchPhase, PhasePromptBuilder> = {
  merge: () => ({ fields: [] }),
  develop: ({ task, signalToken, hasQaPartner }) => {
    if (!signalToken) return { fields: [] };
    return {
      fields: [
        ...(hasQaPartner !== false ? ['spec-signal: spec-done'] : []),
        `signal: ${task.reviewMode === 'server' ? 'code-done' : 'pr-created'}`,
      ],
    };
  },
  code: ({ task }) => ({
    fields: [`signal: ${task.reviewMode === 'server' ? 'code-done' : 'pr-created'}`],
  }),
  fix: ({ task }) => ({
    fields: [
      `pr: ${task.prNumber ?? '<pr-number>'}`,
      `branch: ${task.branch ?? '<branch>'}`,
      `round: ${task.reviewRound}`,
      'signal: pr-fixed',
    ],
  }),
  'post-approve': ({ task, postApproveRedispatchCount }) => ({
    fields: [
      `pr: ${task.prNumber ?? '<pr-number>'}`,
      ...(typeof postApproveRedispatchCount === 'number' && postApproveRedispatchCount > 0
        ? [`redispatch: ${postApproveRedispatchCount}`]
        : []),
      'signal: pr-merge-ready',
    ],
  }),
  review: (ctx) => reviewFields(ctx),
  recheck: (ctx) => reviewFields(ctx),
  'server-review': (ctx) => buildServerReviewInstructions(ctx),
  'server-recheck': (ctx) => buildServerReviewInstructions(ctx),
  'server-spec-review': ({ task, currentSpecRound, serverContent, serverContentFile, serverPriorFindings, serverPriorFindingsFile, serverPriorResponse, serverPriorResponseFile }) => {
    const round = currentSpecRound ?? task.specReviewRound ?? 1;
    return {
      fields: [
        `round: ${round}`,
        ...(serverContentFile ? [fileField('spec-file', serverContentFile)] : []),
        ...(serverPriorFindingsFile ? [fileField('prior-findings-file', serverPriorFindingsFile)] : []),
        ...(serverPriorResponseFile ? [fileField('prior-response-file', serverPriorResponseFile)] : []),
        'signal: spec-reviewed',
      ],
      blocks: [
        ...(serverPriorFindings ? ['prior-findings:', serverPriorFindings] : []),
        ...(serverPriorResponse ? ['prior-response:', serverPriorResponse] : []),
        ...(serverContent !== undefined ? ['spec:', serverContent] : []),
      ],
    };
  },
  'server-feedback': ({ task, currentSpecRound, serverPriorFindings, serverPriorFindingsFile }) => {
    const isSpec = task.phase === 'spec';
    const round = isSpec ? (currentSpecRound ?? task.specReviewRound ?? 1) : task.reviewRound;
    return {
      fields: [
        `feedback: ${isSpec ? 'spec' : 'code'}`,
        `round: ${round}`,
        ...(serverPriorFindingsFile ? [fileField('findings-file', serverPriorFindingsFile)] : []),
        `signal: ${isSpec ? 'spec-fixed' : 'code-fixed'}`,
      ],
      blocks: serverPriorFindings ? ['findings:', serverPriorFindings] : undefined,
    };
  },
  'server-after-done': ({ task, serverAfterDone }) => ({
    fields: [
      `publish: ${serverAfterDone?.kind === 'pr' ? 'pr' : 'branch'}`,
      `branch: ${serverAfterDone?.branch ?? task.branch ?? '<branch>'}`,
      'signal: code-ready',
    ],
  }),
};

function buildServerReviewInstructions(
  { task, serverContent, serverContentFile, serverDiffstat, serverBatch, serverPriorFindings, serverPriorFindingsFile, serverPriorResponse, serverPriorResponseFile }: PhasePromptCtx,
): PhasePrompt {
  const round = task.reviewRound || 1;
  return {
    fields: [
      `round: ${round}`,
      ...(serverBatch ? [`batch: ${serverBatch.index + 1}/${serverBatch.total}`] : []),
      ...(serverContentFile ? [fileField('diff-file', serverContentFile)] : []),
      ...(serverPriorFindingsFile ? [fileField('prior-findings-file', serverPriorFindingsFile)] : []),
      ...(serverPriorResponseFile ? [fileField('prior-response-file', serverPriorResponseFile)] : []),
      'signal: code-reviewed',
    ],
    blocks: [
      ...(serverDiffstat ? ['diffstat:', serverDiffstat] : []),
      ...(serverPriorFindings ? ['prior-findings:', serverPriorFindings] : []),
      ...(serverPriorResponse ? ['prior-response:', serverPriorResponse] : []),
      ...(serverContent !== undefined ? ['diff:', serverContent] : []),
    ],
  };
}

function buildTaskBody(args: TaskBodyArgs): string {
  const {
    task, phase, worktreePath, signalToken, postApproveRedispatchCount,
    currentSpecRound, imagePaths,
    serverContent, serverContentFile, serverDiffstat, serverBatch,
    serverPriorFindings, serverPriorFindingsFile, serverPriorResponse, serverPriorResponseFile,
    serverAfterDone, hasQaPartner,
  } = args;
  if (phase === 'post-approve' && !signalToken) {
    throw new Error('post-approve prompt requires signalToken');
  }
  if ((phase === 'code' || phase === 'review' || phase === 'recheck' || phase === 'fix') && !signalToken) {
    throw new Error(`${phase} prompt requires signalToken`);
  }
  if (phase.startsWith('server-') && !signalToken) {
    throw new Error(`${phase} prompt requires signalToken`);
  }
  if ((serverContent !== undefined && serverContentFile)
    || (serverPriorFindings !== undefined && serverPriorFindingsFile)
    || (serverPriorResponse !== undefined && serverPriorResponseFile)) {
    throw new Error(`${phase} prompt: inline and file payload forms are mutually exclusive`);
  }

  const phaseBuilder = (PHASE_PROMPT_BUILDERS as Record<string, PhasePromptBuilder>)[phase];
  if (!phaseBuilder) {
    throw new Error(`buildTaskBody: no prompt builder registered for phase "${phase}"`);
  }
  const { fields, blocks } = phaseBuilder({
    task, signalToken, currentSpecRound, postApproveRedispatchCount,
    serverContent, serverContentFile, serverDiffstat, serverBatch,
    serverPriorFindings, serverPriorFindingsFile, serverPriorResponse, serverPriorResponseFile,
    serverAfterDone, hasQaPartner,
  });

  // exchange 只有 baxian-task-check（develop/code）消费，其余 phase 不输出
  const carriesExchange = phase === 'develop' || phase === 'code';
  const exchange = task.reviewMode === 'server' ? 'server-files' : 'github-pr';
  const descriptor = [
    `phase: ${phase}`,
    `worktree: ${worktreePath}`,
    ...(carriesExchange ? [`exchange: ${exchange}`] : []),
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
    const leaked = scanPhaseSignals(body).find(s => s.token === signalToken);
    if (leaked) {
      throw new Error(`${phase} prompt must not contain a filled ${leaked.kind} signal literal`);
    }
  }
  return body;
}

export interface PostMergeCleanupContext {
  taskId: string;
  branch: string;
}
