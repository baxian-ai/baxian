import { AGENT_PHASES, type AgentConfig, type AgentRole, type AgentRuntime, type DispatchPhase, type TaskState } from '../shared/index.js';
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
  serverDiffstat?: string;
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorResponse?: string;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  contentTruncated?: boolean;
  hasQaPartner?: boolean;
}

export const MAX_INLINE_FINDINGS_BYTES = 10 * 1024;

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
    role: opts.agent.role,
    worktreePath: opts.worktreePath,
    signalToken: opts.signalToken,
    postApproveRedispatchCount: opts.postApproveRedispatchCount,
    currentSpecRound: opts.currentSpecRound,
    imagePaths: opts.imagePaths,
    serverContent: opts.serverContent,
    serverDiffstat: opts.serverDiffstat,
    serverBatch: opts.serverBatch,
    serverPriorFindings: opts.serverPriorFindings,
    serverPriorResponse: opts.serverPriorResponse,
    serverAfterDone: opts.serverAfterDone,
    contentTruncated: opts.contentTruncated,
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
  role: AgentConfig['role'];
  worktreePath: string;
  signalToken?: string;
  postApproveRedispatchCount?: number;
  currentSpecRound?: number;
  imagePaths?: string[];
  serverContent?: string;
  serverDiffstat?: string;
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorResponse?: string;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  contentTruncated?: boolean;
  hasQaPartner?: boolean;
}

interface PhasePromptCtx {
  task: TaskState;
  signalToken?: string;
  currentSpecRound?: number;
  postApproveRedispatchCount?: number;
  serverContent?: string;
  serverDiffstat?: string;
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorResponse?: string;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  contentTruncated?: boolean;
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
  'server-spec-review': ({ task, contentTruncated, currentSpecRound, serverContent, serverPriorFindings, serverPriorResponse }) => {
    const round = currentSpecRound ?? task.specReviewRound ?? 1;
    const priorFindings = serverPriorFindings ? compactFindings(serverPriorFindings) : undefined;
    const priorResponse = serverPriorResponse ? compactFindings(serverPriorResponse) : undefined;
    return {
      fields: [
        `round: ${round}`,
        ...(contentTruncated ? ['content: truncated'] : []),
        'signal: spec-reviewed',
      ],
      blocks: [
        ...(priorFindings ? [`prior-findings${priorFindings.truncated ? ' (truncated)' : ''}:`, priorFindings.text] : []),
        ...(priorResponse ? [`prior-response${priorResponse.truncated ? ' (truncated)' : ''}:`, priorResponse.text] : []),
        'spec:',
        serverContent ?? '',
      ],
    };
  },
  'server-feedback': ({ task, currentSpecRound, serverPriorFindings }) => {
    const isSpec = task.phase === 'spec';
    const round = isSpec ? (currentSpecRound ?? task.specReviewRound ?? 1) : task.reviewRound;
    const findings = serverPriorFindings ? compactFindings(serverPriorFindings) : undefined;
    return {
      fields: [
        `feedback: ${isSpec ? 'spec' : 'code'}`,
        `round: ${round}`,
        `signal: ${isSpec ? 'spec-fixed' : 'code-fixed'}`,
      ],
      blocks: findings ? [`findings${findings.truncated ? ' (truncated)' : ''}:`, findings.text] : undefined,
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
  { task, serverContent, serverDiffstat, serverBatch, serverPriorFindings, serverPriorResponse, contentTruncated }: PhasePromptCtx,
): PhasePrompt {
  const round = task.reviewRound || 1;
  const priorFindings = serverPriorFindings ? compactFindings(serverPriorFindings) : undefined;
  const priorResponse = serverPriorResponse ? compactFindings(serverPriorResponse) : undefined;
  return {
    fields: [
      `round: ${round}`,
      ...(serverBatch ? [`batch: ${serverBatch.index + 1}/${serverBatch.total}`] : []),
      ...(contentTruncated ? ['content: truncated'] : []),
      'signal: code-reviewed',
    ],
    blocks: [
      ...(serverDiffstat ? ['diffstat:', serverDiffstat] : []),
      ...(priorFindings ? [`prior-findings${priorFindings.truncated ? ' (truncated)' : ''}:`, priorFindings.text] : []),
      ...(priorResponse ? [`prior-response${priorResponse.truncated ? ' (truncated)' : ''}:`, priorResponse.text] : []),
      'diff:',
      serverContent ?? '',
    ],
  };
}

function buildTaskBody(args: TaskBodyArgs): string {
  const {
    task, phase, role, worktreePath, signalToken, postApproveRedispatchCount,
    currentSpecRound, imagePaths,
    serverContent, serverDiffstat, serverBatch,
    serverPriorFindings, serverPriorResponse, serverAfterDone, contentTruncated,
    hasQaPartner,
  } = args;
  const isPrPublish = phase === 'server-after-done' && serverAfterDone?.kind === 'pr';
  const serverExchange = !isPrPublish
    && (phase.startsWith('server-') || task.reviewMode === 'server');
  const exchange = serverExchange ? 'server-files' : 'github-pr';
  if (phase === 'post-approve' && !signalToken) {
    throw new Error('post-approve prompt requires signalToken');
  }
  if ((phase === 'code' || phase === 'review' || phase === 'recheck' || phase === 'fix') && !signalToken) {
    throw new Error(`${phase} prompt requires signalToken`);
  }
  if (phase.startsWith('server-') && !signalToken) {
    throw new Error(`${phase} prompt requires signalToken`);
  }

  const phaseBuilder = (PHASE_PROMPT_BUILDERS as Record<string, PhasePromptBuilder>)[phase];
  if (!phaseBuilder) {
    throw new Error(`buildTaskBody: no prompt builder registered for phase "${phase}"`);
  }
  const { fields, blocks } = phaseBuilder({
    task, signalToken, currentSpecRound, postApproveRedispatchCount,
    serverContent, serverDiffstat, serverBatch,
    serverPriorFindings, serverPriorResponse, serverAfterDone, contentTruncated,
    hasQaPartner,
  });

  const descriptor = [
    `phase: ${phase}`,
    `role: ${role}`,
    `task: ${task.id}`,
    `worktree: ${worktreePath}`,
    `exchange: ${exchange}`,
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

function compactFindings(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_INLINE_FINDINGS_BYTES) {
    return { text, truncated: false };
  }
  let parsed: { findings?: Array<Record<string, unknown>>; responses?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return truncateFindings(text);
  }
  if (Array.isArray(parsed.responses)) return compactResponses(parsed as { responses: Array<Record<string, unknown>> });
  if (!Array.isArray(parsed.findings)) return truncateFindings(text);
  for (const messageCap of [200, 80]) {
    const compacted = {
      ...parsed,
      findings: parsed.findings.map(f => ({
        ...f,
        ...(typeof f.message === 'string' && f.message.length > messageCap
          ? { message: `${f.message.slice(0, messageCap)}…` }
          : {}),
      })),
    };
    const out = JSON.stringify(compacted);
    if (Buffer.byteLength(out, 'utf8') <= MAX_INLINE_FINDINGS_BYTES) {
      return { text: out, truncated: true };
    }
  }
  const idsOnly = JSON.stringify({
    ...parsed,
    note: 'messages omitted for size; respond to EVERY finding id below',
    findings: parsed.findings.map(f => ({
      id: f.id,
      severity: f.severity,
      ...(f.file !== undefined ? { file: f.file } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.location !== undefined ? { location: f.location } : {}),
    })),
  });
  return { text: idsOnly, truncated: true };
}

function compactResponses(parsed: { responses: Array<Record<string, unknown>> }): { text: string; truncated: boolean } {
  for (const rationaleCap of [200, 80]) {
    const compacted = {
      ...parsed,
      responses: parsed.responses.map(r => ({
        ...r,
        ...(typeof r.rationale === 'string' && r.rationale.length > rationaleCap
          ? { rationale: `${r.rationale.slice(0, rationaleCap)}…` }
          : {}),
      })),
    };
    const out = JSON.stringify(compacted);
    if (Buffer.byteLength(out, 'utf8') <= MAX_INLINE_FINDINGS_BYTES) {
      return { text: out, truncated: true };
    }
  }
  const skeleton = JSON.stringify({
    ...parsed,
    note: 'rationales omitted for size; every response id/action is listed below',
    responses: parsed.responses.map(r => ({
      findingId: r.findingId,
      action: r.action,
      ...(r.commitSha !== undefined ? { commitSha: r.commitSha } : {}),
    })),
  });
  return { text: skeleton, truncated: true };
}

function truncateFindings(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= MAX_INLINE_FINDINGS_BYTES) return { text, truncated: false };
  let cut = MAX_INLINE_FINDINGS_BYTES;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true };
}

export interface PostMergeCleanupContext {
  taskId: string;
  branch: string;
}
