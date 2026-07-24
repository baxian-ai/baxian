import { AGENT_PHASES, type AgentConfig, type AgentRole, type AgentRuntime, type DispatchPhase, type ReviewContentFileRef, type TaskState } from '../shared/index.js';
import type { SkillRegistry } from '../skill/registry.js';
import { scanNeedInputSignals, scanPhaseSignals } from './phase-signal.js';

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
  if (task.reviewMode !== 'git' || !GIT_PLATFORM_PHASES.has(phase)) return [];
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
  currentSpecRound?: number;
  imagePaths?: string[];
  serverContent?: string;
  serverContentFile?: ReviewContentFileRef;
  serverDiffstat?: string;
  serverDiffstatFile?: ReviewContentFileRef;
  serverInterdiff?: string;
  serverInterdiffFile?: ReviewContentFileRef;
  serverReviewCheckout?: 'head' | 'base';
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorFindingsFile?: ReviewContentFileRef;
  serverFindingsDigest?: string;
  serverFeedbackCorrection?: ServerFeedbackCorrectionPrompt;
  serverPriorResponse?: string;
  serverPriorResponseFile?: ReviewContentFileRef;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  hasQaPartner?: boolean;
  platformCli?: PlatformCliDescriptor;
}

export interface ServerFeedbackCorrectionPrompt {
  reason: string;
  missingFindingIds?: string[];
  unknownFindingIds?: string[];
  schemaViolationCodes?: string[];
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
    currentSpecRound: opts.currentSpecRound,
    imagePaths: opts.imagePaths,
    serverContent: opts.serverContent,
    serverContentFile: opts.serverContentFile,
    serverDiffstat: opts.serverDiffstat,
    serverDiffstatFile: opts.serverDiffstatFile,
    serverInterdiff: opts.serverInterdiff,
    serverInterdiffFile: opts.serverInterdiffFile,
    serverReviewCheckout: opts.serverReviewCheckout,
    serverBatch: opts.serverBatch,
    serverPriorFindings: opts.serverPriorFindings,
    serverPriorFindingsFile: opts.serverPriorFindingsFile,
    serverFindingsDigest: opts.serverFindingsDigest,
    serverFeedbackCorrection: opts.serverFeedbackCorrection,
    serverPriorResponse: opts.serverPriorResponse,
    serverPriorResponseFile: opts.serverPriorResponseFile,
    serverAfterDone: opts.serverAfterDone,
    hasQaPartner: opts.hasQaPartner,
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
  currentSpecRound?: number;
  imagePaths?: string[];
  serverContent?: string;
  serverContentFile?: ReviewContentFileRef;
  serverDiffstat?: string;
  serverDiffstatFile?: ReviewContentFileRef;
  serverInterdiff?: string;
  serverInterdiffFile?: ReviewContentFileRef;
  serverReviewCheckout?: 'head' | 'base';
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorFindingsFile?: ReviewContentFileRef;
  serverFindingsDigest?: string;
  serverFeedbackCorrection?: ServerFeedbackCorrectionPrompt;
  serverPriorResponse?: string;
  serverPriorResponseFile?: ReviewContentFileRef;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  hasQaPartner?: boolean;
  platformCli?: PlatformCliDescriptor;
}

interface PhasePromptCtx {
  task: TaskState;
  signalToken?: string;
  currentSpecRound?: number;
  serverContent?: string;
  serverContentFile?: ReviewContentFileRef;
  serverDiffstat?: string;
  serverDiffstatFile?: ReviewContentFileRef;
  serverInterdiff?: string;
  serverInterdiffFile?: ReviewContentFileRef;
  serverReviewCheckout?: 'head' | 'base';
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorFindingsFile?: ReviewContentFileRef;
  serverFindingsDigest?: string;
  serverFeedbackCorrection?: ServerFeedbackCorrectionPrompt;
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
  research: () => ({ fields: ['signal: spec-done'] }),
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
      'signal: pr-fixed',
    ],
  }),
  'post-approve': ({ task }) => ({
    fields: [
      `pr: ${task.prNumber ?? '<pr-number>'}`,
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
  'server-feedback': ({
    task,
    currentSpecRound,
    serverPriorFindings,
    serverPriorFindingsFile,
    serverFindingsDigest,
    serverFeedbackCorrection,
  }) => {
    if (!serverFindingsDigest) throw new Error('server-feedback prompt requires findings digest');
    const isSpec = task.phase === 'spec';
    const round = isSpec ? (currentSpecRound ?? task.specReviewRound ?? 1) : Math.max(task.reviewRound, 1);
    return {
      fields: [
        `feedback: ${isSpec ? 'spec' : 'code'}`,
        `round: ${round}`,
        `findings-digest: ${serverFindingsDigest}`,
        ...(serverPriorFindingsFile ? [fileField('findings-file', serverPriorFindingsFile)] : []),
        ...(serverFeedbackCorrection ? [
          `correction-reason: ${serverFeedbackCorrection.reason}`,
          `missing-finding-ids: ${JSON.stringify(serverFeedbackCorrection.missingFindingIds ?? [])}`,
          `unknown-finding-ids: ${JSON.stringify(serverFeedbackCorrection.unknownFindingIds ?? [])}`,
          `schema-violation-codes: ${JSON.stringify(serverFeedbackCorrection.schemaViolationCodes ?? [])}`,
        ] : []),
        `signal: ${isSpec ? 'spec-fixed' : 'code-fixed'}`,
      ],
      blocks: serverPriorFindings ? ['findings:', serverPriorFindings] : undefined,
    };
  },
  'server-after-done': ({ task, serverAfterDone }) => {
    // publish: pr 走 baxian-server-feedback 的 PR 分支，它要显式 -R/--base/--head：
    // 归一化 repo 身份与 base 快照都由 server 下发，agent 不现场推断远端。
    const publishesPr = serverAfterDone?.kind === 'pr';
    return {
      fields: [
        `publish: ${publishesPr ? 'pr' : 'branch'}`,
        `branch: ${serverAfterDone?.branch ?? task.branch ?? '<branch>'}`,
        ...(publishesPr && task.platformBinding ? [`repo: ${task.platformBinding.repoKey}`] : []),
        ...(publishesPr && task.baseBranch ? [`base: ${task.baseBranch}`] : []),
        'signal: code-ready',
      ],
    };
  },
};

function buildServerReviewInstructions(
  {
    task,
    serverContent,
    serverContentFile,
    serverDiffstat,
    serverDiffstatFile,
    serverInterdiff,
    serverInterdiffFile,
    serverReviewCheckout,
    serverBatch,
    serverPriorFindings,
    serverPriorFindingsFile,
    serverPriorResponse,
    serverPriorResponseFile,
  }: PhasePromptCtx,
): PhasePrompt {
  const round = task.reviewRound || 1;
  return {
    fields: [
      `round: ${round}`,
      ...(serverReviewCheckout ? [`review-checkout: ${serverReviewCheckout}`] : []),
      ...(serverBatch ? [`batch: ${serverBatch.index + 1}/${serverBatch.total}`] : []),
      ...(serverContentFile ? [fileField('diff-file', serverContentFile)] : []),
      ...(serverDiffstatFile ? [fileField('diffstat-file', serverDiffstatFile)] : []),
      ...(serverInterdiffFile ? [fileField('interdiff-file', serverInterdiffFile)] : []),
      ...(serverPriorFindingsFile ? [fileField('prior-findings-file', serverPriorFindingsFile)] : []),
      ...(serverPriorResponseFile ? [fileField('prior-response-file', serverPriorResponseFile)] : []),
      'signal: code-reviewed',
    ],
    blocks: [
      ...(serverDiffstat ? ['diffstat:', serverDiffstat] : []),
      ...(serverPriorFindings ? ['prior-findings:', serverPriorFindings] : []),
      ...(serverPriorResponse ? ['prior-response:', serverPriorResponse] : []),
      ...(serverInterdiff !== undefined ? ['interdiff (本轮相对上一轮的增量，优先核对；全量 diff 供交叉确认):', serverInterdiff] : []),
      ...(serverContent !== undefined ? ['diff:', serverContent] : []),
    ],
  };
}

function buildTaskBody(args: TaskBodyArgs): string {
  const {
    task, phase, workdir, signalToken,
    currentSpecRound, imagePaths,
    serverContent, serverContentFile, serverDiffstat, serverDiffstatFile, serverInterdiff, serverInterdiffFile,
    serverReviewCheckout, serverBatch,
    serverPriorFindings, serverPriorFindingsFile, serverFindingsDigest, serverFeedbackCorrection,
    serverPriorResponse, serverPriorResponseFile,
    serverAfterDone, hasQaPartner, platformCli,
  } = args;
  if (phase === 'post-approve' && !signalToken) {
    throw new Error('post-approve prompt requires signalToken');
  }
  if ((phase === 'research' || phase === 'code' || phase === 'review' || phase === 'recheck' || phase === 'fix') && !signalToken) {
    throw new Error(`${phase} prompt requires signalToken`);
  }
  if (phase.startsWith('server-') && !signalToken) {
    throw new Error(`${phase} prompt requires signalToken`);
  }
  if ((serverContent !== undefined && serverContentFile)
    || (serverDiffstat !== undefined && serverDiffstatFile)
    || (serverInterdiff !== undefined && serverInterdiffFile)
    || (serverPriorFindings !== undefined && serverPriorFindingsFile)
    || (serverPriorResponse !== undefined && serverPriorResponseFile)) {
    throw new Error(`${phase} prompt: inline and file payload forms are mutually exclusive`);
  }

  const phaseBuilder = (PHASE_PROMPT_BUILDERS as Record<string, PhasePromptBuilder>)[phase];
  if (!phaseBuilder) {
    throw new Error(`buildTaskBody: no prompt builder registered for phase "${phase}"`);
  }
  const { fields, blocks } = phaseBuilder({
    task, signalToken, currentSpecRound,
    serverContent, serverContentFile, serverDiffstat, serverDiffstatFile, serverInterdiff, serverInterdiffFile,
    serverReviewCheckout, serverBatch,
    serverPriorFindings, serverPriorFindingsFile, serverFindingsDigest, serverFeedbackCorrection,
    serverPriorResponse, serverPriorResponseFile,
    serverAfterDone, hasQaPartner,
  });

  // exchange 只有 baxian-task-check（develop/code）消费，其余 phase 不输出
  const carriesExchange = phase === 'develop' || phase === 'code';
  const exchange = task.reviewMode === 'server' ? 'server-files' : 'git-pr';
  const descriptor = [
    `phase: ${phase}`,
    `workdir: ${workdir}`,
    ...(carriesExchange ? [`exchange: ${exchange}`] : []),
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
    const leaked = scanPhaseSignals(body).find(s => s.token === signalToken);
    if (leaked) {
      throw new Error(`${phase} prompt must not contain a filled ${leaked.kind} signal literal`);
    }
    if (scanNeedInputSignals(body).some(s => s.token === signalToken)) {
      throw new Error(`${phase} prompt must not contain a filled need-input signal literal`);
    }
  }
  return body;
}

export interface PostMergeCleanupContext {
  taskId: string;
  branch: string;
}
