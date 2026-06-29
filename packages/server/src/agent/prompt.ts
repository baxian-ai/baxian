import { AGENT_PHASES, type AgentConfig, type AgentRole, type AgentRuntime, type DispatchPhase, type TaskState } from '../shared/index.js';
import type { SkillRegistry } from '../skill/registry.js';
import { scanPhaseSignals } from './phase-signal.js';

export const BAXIAN_PR_CLAIM = '<!-- baxian:managed -->';

export const MAX_PROMPT_BYTES = 80 * 1024;
// 1KB margin: preview uses placeholders; real worktree path may be longer at inject.
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

// Each runtime exposes on-disk skills as a single command: Claude Code fires
// `/skill-name`, Codex fires `$skill-name`. baxian controls the pasted bytes, so
// emitting the command on the first line force-loads that skill's full body
// deterministically; the multi-line task body rides along as the command input.
const SKILL_INVOKE_SIGIL: Record<AgentRuntime, string> = {
  'claude-code': '/',
  codex: '$',
};

// The one phase-specific skill to force-load via the single per-message command
// slot. undefined when a phase declares no skill (merge / server-* run on inline
// instructions only).
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
  /** Current pending pane-signal token. Required for phases that emit a signal. */
  signalToken?: string;
  // >0 → post-approve prompt 走 incremental nudge：dev pane 已带完整 post-approve 上下文，
  // 重灌完整长段会让 agent 失焦，只发"有新 feedback 增量再扫一遍"的短指令。
  postApproveRedispatchCount?: number;
  /** Caller-transmitted round — task field is stale during dispatch. */
  currentSpecRound?: number;
  /** Absolute agent-host image paths to weave into the task body. */
  imagePaths?: string[];
  /** Server mode: injected review input (diff or spec doc), pre-sized by the caller. */
  serverContent?: string;
  serverDiffstat?: string;
  serverBatch?: { index: number; total: number };
  serverPriorFindings?: string;
  serverPriorResponse?: string;
  serverAfterDone?: { kind: 'branch' | 'pr'; branch: string };
  contentTruncated?: boolean;
  // === false 时 develop prompt 不提供 spec review 路线（无 QA 则 spec-done 是死路）；
  // undefined 视为未知，保留该段（尺寸预估等路径取 worst-case）。
  hasQaPartner?: boolean;
}

export const MAX_INLINE_FINDINGS_BYTES = 10 * 1024;

// Throws PromptSizeError when fullPrompt > MAX_PROMPT_BYTES, or
// RequiredSkillsMissingError when a phase-declared skill cannot be resolved.
// The check exists because skillsForPhase() silently filters missing names —
// without this fail-fast the prompt would build with silently-degraded behavior
// and no operator-visible signal.
export function buildPromptInline(opts: BuildPromptOpts): string {
  // A signal-emitting prompt now points at the baxian-signals skill for the emit rules
  // instead of inlining them, so that skill MUST be resolvable — fail loud here rather than
  // ship a prompt whose signal silently never fires because the rules were never loadable.
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
  // Force-load the phase skill via the runtime's command on the first line. EVERY dispatch
  // re-emits it: a dispatch is one slash-command invocation, and re-firing re-injects the
  // (small) skill body deterministically, so the procedure is guaranteed resident regardless
  // of prior /compact or context drift — never assume the model still remembers an earlier load.
  const primary = phasePrimarySkill(opts.agent.role, opts.phase);
  // A signal-emitting phase with NO primary skill (the server-* phases) would otherwise leave the
  // command slot empty and rely on the model to implicitly load baxian-signals — but the emit rules
  // now live ONLY there, so a miss means the signal silently never fires. Force-load baxian-signals
  // into the free slot so the protocol is deterministically in context (GitHub phases keep their
  // primary skill, whose own body points at baxian-signals).
  const slotSkill = primary ?? (opts.signalToken ? 'baxian-signals' : undefined);
  const invokeLine = slotSkill
    ? `${SKILL_INVOKE_SIGIL[opts.agent.runtime]}${slotSkill}\n`
    : '';
  const fullPrompt = invokeLine + taskBody;
  const bytes = Buffer.byteLength(fullPrompt, 'utf8');
  if (bytes > MAX_PROMPT_BYTES) throw new PromptSizeError(bytes);
  return fullPrompt;
}

// Bootstrap capability handshake. Force-loads the baxian-greeting skill exactly like a real
// phase dispatch force-loads its primary skill (the command slot is free during bootstrap), and
// that skill delegates the wire rules to baxian-signals — so a passing greeting exercises the
// same force-load + signal-skill chain real dispatches use. The token rides as the command input.
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
// The prompt body baxian injects is a structured descriptor, not prose: `fields` are
// the per-dispatch key:value lines (variable data only), `blocks` are large injected
// payloads (diff / spec / findings) appended after the task body. All procedure lives
// in the force-loaded phase skill, which reads these fields by name.
interface PhasePrompt {
  fields: string[];
  blocks?: string[];
}
type PhasePromptBuilder = (ctx: PhasePromptCtx) => PhasePrompt;

// review/recheck verdict via native `gh pr review` (no completion signal); the 422
// fallback signal kinds are fixed and live in the skill, so only pr + anchor-sha vary.
function reviewFields({ task }: PhasePromptCtx): PhasePrompt {
  return {
    fields: [
      `pr: ${task.prNumber ?? '<pr-number>'}`,
      ...(task.reviewHeadAnchorSha ? [`anchor-sha: ${task.reviewHeadAnchorSha}`] : []),
    ],
  };
}

// Single source of truth for per-phase prompt instructions, keyed by an exhaustive
// Record<DispatchPhase, …>: a phase shipped without a builder is a COMPILE error.
// `merge` runs through the /compact cleanup path (not buildTaskBody), so its builder is empty by design.
const PHASE_PROMPT_BUILDERS: Record<DispatchPhase, PhasePromptBuilder> = {
  merge: () => ({ fields: [] }),
  // develop: implement and emit the done-signal (pr-created on GitHub, code-done on
  // server). When a QA partner exists, spec-signal offers the optional SDD route. All
  // mechanics live in baxian-task-check §Develop.
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
  // Server-transit phases exchange via .baxian/review files (no PR/Issue), so the
  // GitHub-PR conventions would contradict the same prompt's server-mode steps. Key
  // on the PHASE, not task.reviewMode: SDD spec review/feedback run server-spec-review
  // / server-feedback even on a GitHub-mode task (reviewMode !== 'server'). The only
  // exception is server-after-done's PR variant — it opens a PR (managed marker); its
  // branch variant just pushes a branch (code-ready) and keeps the server header.
  const isPrPublish = phase === 'server-after-done' && serverAfterDone?.kind === 'pr';
  const serverExchange = !isPrPublish
    && (phase.startsWith('server-') || task.reviewMode === 'server');
  // exchange selects the cross-agent medium; the full conventions for each mode live in the
  // force-loaded phase skill (GitHub PR vs `.baxian/review/*.json`), not inline.
  const exchange = serverExchange ? 'server-files' : 'github-pr';
  if (phase === 'post-approve' && !signalToken) {
    throw new Error('post-approve prompt requires signalToken');
  }
  // 'code' (pr-created) always needs a token; review/recheck need it for the
  // same-identity (422) fallback verdict signal; 'fix' needs it for the pr-fixed
  // completion signal that drives fixing→review — see the phase blocks below.
  if ((phase === 'code' || phase === 'review' || phase === 'recheck' || phase === 'fix') && !signalToken) {
    throw new Error(`${phase} prompt requires signalToken`);
  }
  if (phase.startsWith('server-') && !signalToken) {
    throw new Error(`${phase} prompt requires signalToken`);
  }

  const phaseBuilder = (PHASE_PROMPT_BUILDERS as Record<string, PhasePromptBuilder>)[phase];
  if (!phaseBuilder) {
    // Fail loud: an unknown phase reaching here is a dispatch typo, not an empty
    // prompt to ship silently.
    throw new Error(`buildTaskBody: no prompt builder registered for phase "${phase}"`);
  }
  const { fields, blocks } = phaseBuilder({
    task, signalToken, currentSpecRound, postApproveRedispatchCount,
    serverContent, serverDiffstat, serverBatch,
    serverPriorFindings, serverPriorResponse, serverAfterDone, contentTruncated,
    hasQaPartner,
  });

  // Structured descriptor: baxian metadata as key:value the force-loaded phase skill reads
  // by name. token rides as a field (never a filled `[bx:...]` literal) so the prompt itself
  // can't self-fire the watcher.
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
  // Guard: the rendered body must not contain a filled signal literal that
  // would fire the watcher. We run the scanner over body and reject any match
  // whose token equals the active signalToken. This catches accidental leaks
  // from skill content / task title / description, and is the same logic
  // PaneStreamer uses to identify fireable signals.
  if (signalToken) {
    const leaked = scanPhaseSignals(body).find(s => s.token === signalToken);
    if (leaked) {
      throw new Error(`${phase} prompt must not contain a filled ${leaked.kind} signal literal`);
    }
  }
  return body;
}


// Exchange-JSON injection must NEVER drop structural ids: findings ids feed the
// dev's coverage validation, response ids feed QA's closure verification —
// a tail-truncated set self-locks or blinds the round. Compact the prose
// fields (message/rationale) instead; structural skeletons always survive.
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
  // Last tier: structural fields only, NO tail truncation — a clipped id set
  // self-locks the round on coverage validation. The 80KB prompt ceiling is the
  // remaining (loud) backstop for pathological finding counts.
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
  // 回退到 UTF-8 字符边界，避免截出不可解析的多字节序列。
  let cut = MAX_INLINE_FINDINGS_BYTES;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true };
}


// Post-merge cleanup is silent toward the agent (no notification): baxian removes the worktree,
// deletes the local branch, then /clears the idle pane. This carries just the ids that cleanup needs.
export interface PostMergeCleanupContext {
  taskId: string;
  branch: string;
}
