import { AGENT_PHASES, REVIEW_EXCHANGE_DIR, SPEC_DOC_RELPATH, type AgentConfig, type AgentRole, type DispatchPhase, type TaskState } from '../shared/index.js';
import type { SkillRegistry } from '../skill/registry.js';
import { buildPhaseSignalTemplate, scanPhaseSignals } from './phase-signal.js';

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

// Global invariants every dispatch carries, independent of phase. baxian-rules
// holds backend-state-machine constraints (verdict marker grammar, PR signal,
// etc.) that must be present even if a phase's AGENT_PHASES entry forgets it.
const GLOBAL_REQUIRED_SKILLS: readonly string[] = ['baxian-rules'];

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function xmlEscapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, c => XML_ESCAPE[c]);
}

// CDATA cannot contain `]]>`; split across two sections.
// Newlines around the fence keep tag boundaries visually separated from content.
function cdata(content: string): string {
  return `<![CDATA[\n${content.replace(/]]>/g, ']]]]><![CDATA[>')}\n]]>`;
}

export function buildSkillsXml(
  role: AgentRole,
  phase: string,
  registry: SkillRegistry,
  excludeSkills: readonly string[] = [],
): string {
  const names = registry.skillsForPhase(role, phase);
  const exclude = new Set(excludeSkills);
  const emitted = names.filter(name => !exclude.has(name));
  if (emitted.length === 0) return '';
  const skillBlocks: string[] = [];
  for (const name of emitted) {
    const def = registry.get(name);
    if (!def) continue;
    const fileBlocks = def.files
      .map(file => `      <file path="${xmlEscapeAttr(file.relPath)}">${cdata(file.text)}</file>`)
      .join('\n');
    skillBlocks.push(
      `  <skill>\n` +
      `    <name>${xmlEscapeAttr(def.name)}</name>\n` +
      `    <description>${xmlEscapeAttr(def.description)}</description>\n` +
      `    <files>\n${fileBlocks}\n    </files>\n` +
      `  </skill>`,
    );
  }
  return `<skills>\n${skillBlocks.join('\n')}\n</skills>`;
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
  // Skills already in the REPL's context for the current (task, pane); omit
  // from the <skills> payload to avoid re-inlining content the model still
  // remembers. Registry-required check still runs over the full set.
  excludeSkills?: readonly string[];
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
// RequiredSkillsMissingError when a global or phase-declared skill cannot be
// resolved. The phase-declared check exists because skillsForPhase() silently
// filters missing names — without this fail-fast the prompt would build with
// silently-degraded behavior and no operator-visible signal.
export function buildPromptInline(opts: BuildPromptOpts): string {
  const phaseDeclared = AGENT_PHASES[opts.agent.role]?.[opts.phase]?.skills ?? [];
  const required = [...new Set([...GLOBAL_REQUIRED_SKILLS, ...phaseDeclared])];
  const missing = required.filter(name => !opts.skillRegistry.has(name));
  if (missing.length > 0) throw new RequiredSkillsMissingError(missing);
  const skillsXml = buildSkillsXml(
    opts.agent.role,
    opts.phase,
    opts.skillRegistry,
    opts.excludeSkills,
  );
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
  const taskBlock = `<task>${cdata(taskBody)}</task>`;
  const fullPrompt = skillsXml ? `${skillsXml}\n${taskBlock}` : taskBlock;
  const bytes = Buffer.byteLength(fullPrompt, 'utf8');
  if (bytes > MAX_PROMPT_BYTES) throw new PromptSizeError(bytes);
  return fullPrompt;
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
type PhasePromptBuilder = (ctx: PhasePromptCtx) => string;

function buildReviewOrRecheckInstructions(
  { task, signalToken }: PhasePromptCtx,
  isRecheck: boolean,
): string {
  const prRef = task.prNumber !== undefined ? String(task.prNumber) : '<pr-number>';
  return [
    `Code ${isRecheck ? 'recheck' : 'review'} phase:`,
    isRecheck
      ? '- Dev pushed new commits. Re-check prior feedback and task spec.'
      : '- Check out PR branch, review changes against task spec.',
    `- Execute verdict per ${isRecheck ? 'pr-recheck' : 'pr-review'} skill §Verdict. PR number: ${prRef}`,
    `  Build the \`gh pr review ${prRef}\` commands per the verdict table, substituting N=${prRef} and TOKEN=${signalToken}.`,
    `- 422 fallback signals:`,
    `    ${buildPhaseSignalTemplate('pr-approved')}`,
    `    ${buildPhaseSignalTemplate('pr-changes-requested')}`,
    `  token: ${signalToken}`,
    '',
  ].join('\n');
}

// Single source of truth for per-phase prompt instructions, keyed by an exhaustive
// Record<DispatchPhase, …>: a phase shipped without a builder is a COMPILE error.
// `merge` runs through the /compact cleanup path (not buildTaskBody), so its builder is empty by design.
const PHASE_PROMPT_BUILDERS: Record<DispatchPhase, PhasePromptBuilder> = {
  merge: () => '',
  develop: ({ task, signalToken, hasQaPartner }) => {
    if (!signalToken) return '';
    // spec review 由 QA 执行；没有 QA 时不提供该路线，spec-done 会派不出去。
    const offerSpec = hasQaPartner !== false;
    if (task.reviewMode === 'server') {
      return [
        'Server review mode — no PRs, no branch pushes during review.',
        ...(offerSpec
          ? [
              'Specification-Driven Development (SDD) — optional:',
              `- To get QA spec review first, write the spec to ${SPEC_DOC_RELPATH} in your worktree (do NOT commit or push it), then signal:`,
              `    ${buildPhaseSignalTemplate('spec-done')}`,
              `  token: ${signalToken}`,
              '- Otherwise implement the change, commit locally (do NOT push), then signal:',
            ]
          : ['- Implement the change, commit locally (do NOT push), then signal:']),
        `    ${buildPhaseSignalTemplate('code-done')}`,
        `  token: ${signalToken}`,
        '',
      ].join('\n');
    }
    return [
      ...(offerSpec
        ? [
            'Specification-Driven Development (SDD) — optional:',
            `- To get QA spec review first, write the spec to ${SPEC_DOC_RELPATH} in your worktree (do NOT commit or push it), then signal:`,
            `    ${buildPhaseSignalTemplate('spec-done')}`,
            `  token: ${signalToken}`,
            '- Otherwise proceed straight to implementing the change. After `gh pr create`, signal:',
          ]
        : ['Implement the change. After `gh pr create`, signal:']),
      `    ${buildPhaseSignalTemplate('pr-created')}`,
      `  token: ${signalToken}`,
      '',
    ].join('\n');
  },
  code: ({ task, signalToken }) => task.reviewMode === 'server'
    ? [
        'Code phase (server review mode):',
        `- Spec is approved. Implement code per the spec at ${SPEC_DOC_RELPATH}.`,
        '- Commit locally. Do NOT push and do NOT open a PR — baxian reads your worktree directly.',
        '- When done, signal:',
        `    ${buildPhaseSignalTemplate('code-done')}`,
        `  token: ${signalToken}`,
        '',
      ].join('\n')
    : [
        'Code phase:',
        `- Spec is approved. Implement code per the spec at ${SPEC_DOC_RELPATH}.`,
        '- Commit+push, open PR via `gh pr create`. After it returns, signal with PR number:',
        `    ${buildPhaseSignalTemplate('pr-created')}`,
        `  token: ${signalToken}`,
        '',
      ].join('\n'),
  fix: ({ task, signalToken }) => {
    const round = task.reviewRound;
    const prRef = task.prNumber !== undefined ? String(task.prNumber) : '<pr-number>';
    const branch = task.branch ?? '<branch>';
    return [
      `Fix phase (review round ${round}):`,
      `- QA requested changes on PR ${prRef}. Read all feedback per pr-feedback §Fetch Feedback.`,
      `- Address every finding per pr-feedback §Decide and Act. Judge independently.`,
      `- If you change code, commit then push: \`git push origin HEAD:${branch}\`.`,
      `- When done, emit per pr-feedback skill §Fix Completion:`,
      `    ${buildPhaseSignalTemplate('pr-fixed')}`,
      `  token: ${signalToken}`,
      '',
    ].join('\n');
  },
  'post-approve': ({ signalToken, postApproveRedispatchCount }) =>
    typeof postApproveRedispatchCount === 'number' && postApproveRedispatchCount > 0
      ? [
          `Post-approve recheck (redispatch #${postApproveRedispatchCount}):`,
          '- New PR feedback arrived while you were running. Re-read the three sources and handle any non-self item with created_at > T_self per the first-pass rules already in your context.',
          '- Fix or reply "Won\'t fix" each item. If you push code, baxian routes to QA for recheck.',
          '- Before echoing the signal: re-fetch one more time and only emit when no unhandled items remain.',
          `    ${buildPhaseSignalTemplate('pr-merge-ready')}`,
          `  token: ${signalToken}`,
          '',
        ].join('\n')
      : [
          'Post-approve PR feedback check:',
          '- QA approved. Before merge, read all PR feedback per pr-feedback §Fetch Feedback.',
          '- Idempotency: compute T_self = your latest reply timestamp per source. Respond to EVERY non-self comment with created_at > T_self. Apply per review thread and across issue-comment stream.',
          '- Address each per pr-feedback §Decide and Act. If code changes, commit+push (baxian routes to QA for recheck) and STOP — do not emit pr-merge-ready when you pushed code.',
          '- If no code changes were needed, re-fetch all sources before signaling. The server suppresses redispatches while you run, so new comments only reach you via this re-fetch. If unhandled items remain, process and re-fetch again. Only signal when clean:',
          `    ${buildPhaseSignalTemplate('pr-merge-ready')}`,
          `  token: ${signalToken}`,
          '- Do not merge the PR yourself from this phase.',
          '',
        ].join('\n'),
  review: (ctx) => buildReviewOrRecheckInstructions(ctx, false),
  recheck: (ctx) => buildReviewOrRecheckInstructions(ctx, true),
  'server-review': (ctx) => buildServerReviewInstructions(ctx, false),
  'server-recheck': (ctx) => buildServerReviewInstructions(ctx, true),
  'server-spec-review': ({ task, signalToken, serverContent, contentTruncated, currentSpecRound, serverPriorFindings, serverPriorResponse }) => {
    const round = currentSpecRound ?? task.specReviewRound ?? 1;
    const priorFindings = serverPriorFindings ? compactFindings(serverPriorFindings) : undefined;
    const priorResponse = serverPriorResponse ? compactFindings(serverPriorResponse) : undefined;
    return [
      `Server spec review phase (round ${round}):`,
      '- Review the spec injected below. Do NOT fetch branches or use gh; this is the review input.',
      ...(priorFindings
        ? ['- Prior findings and the dev response are included below. Verify every finding is closed (revised with evidence, or convincingly rejected) before judging the rest of the spec.']
        : []),
      ...(contentTruncated
        ? ['- Content truncated. Request more via [bx:read-file:<path>:<start>-<end>] (relative path, ≤200 lines).']
        : []),
      `- Write findings to ${REVIEW_EXCHANGE_DIR}/findings.json in YOUR worktree (\`mkdir -p ${REVIEW_EXCHANGE_DIR}\` first). Atomic write: write findings.json.tmp first, then \`mv findings.json.tmp findings.json\`.`,
      `- Schema: {"round":${round},"verdict":"approve"|"request-changes","findings":[{"id":"f-1","severity":"critical"|"major"|"minor","location":"Section ...","message":"..."}]}`,
      '- Approve MAY carry minor findings as suggestions; verdict field is authoritative.',
      `- Then emit exactly once: ${buildPhaseSignalTemplate('spec-reviewed')}`,
      `  token: ${signalToken}`,
      ...(priorFindings
        ? ['', `prior findings${priorFindings.truncated ? ' [truncated]' : ''}:`, priorFindings.text]
        : []),
      ...(priorResponse
        ? ['', `dev response${priorResponse.truncated ? ' [truncated]' : ''}:`, priorResponse.text]
        : []),
      '',
      'spec content:',
      serverContent ?? '',
      '',
    ].join('\n');
  },
  'server-feedback': ({ task, signalToken, serverPriorFindings, currentSpecRound }) => {
    const isSpec = task.phase === 'spec';
    const round = isSpec ? (currentSpecRound ?? task.specReviewRound ?? 1) : task.reviewRound;
    const signalKind = isSpec ? 'spec-fixed' : 'code-fixed';
    const truncated = serverPriorFindings ? compactFindings(serverPriorFindings) : undefined;
    return [
      `Server feedback phase (${isSpec ? 'spec' : 'code'} round ${round}):`,
      `- QA findings are injected below. Handle EVERY finding by id:`,
      isSpec
        ? `    fix — revise ${SPEC_DOC_RELPATH} in place (do NOT commit or push it).`
        : '    fix — change the code/spec, commit; include commitSha in your response item.',
      '    reject — concrete rationale why the finding is wrong or not applicable.',
      '    out-of-scope — rationale plus where it is tracked (issue link or task note).',
      `- Write your response to ${REVIEW_EXCHANGE_DIR}/response.json in your worktree (\`mkdir -p ${REVIEW_EXCHANGE_DIR}\` first). Atomic write: response.json.tmp then \`mv\`.`,
      isSpec
        ? `- Schema: {"round":${round},"responses":[{"findingId":"f-1","action":"fix"|"reject"|"out-of-scope","rationale":"..."}]}`
        : `- Schema: {"round":${round},"responses":[{"findingId":"f-1","action":"fix"|"reject"|"out-of-scope","rationale":"...","commitSha":"..."}]}`,
      '- Every finding id MUST have exactly one response item (ids may look like b0-f-1 when the review was batched).',
      `- Then emit exactly once: ${buildPhaseSignalTemplate(signalKind)}`,
      `  token: ${signalToken}`,
      ...(truncated
        ? [
            '',
            `findings (round ${round})${truncated.truncated ? ' [truncated]' : ''}:`,
            truncated.text,
          ]
        : []),
      '',
    ].join('\n');
  },
  'server-after-done': ({ task, signalToken, serverAfterDone }) => {
    const branch = serverAfterDone?.branch ?? task.branch ?? '<branch>';
    if (serverAfterDone?.kind === 'pr') {
      return [
        'Publish phase (push + PR):',
        `- Push the reviewed branch: \`git push -u origin ${branch}\`.`,
        '- Open a PR via `gh pr create` (title: task title; body: short summary of the server-side review outcome).',
        `- The PR body MUST end with the marker line \`${BAXIAN_PR_CLAIM}\` — without it baxian's poller treats the PR as unmanaged and ignores its merge/comment events.`,
        '- Then emit exactly once, substituting the real PR number:',
        '    [bx:code-ready:<pr_number>:<token>]',
        `  token: ${signalToken}`,
        '',
      ].join('\n');
    }
    return [
      'Publish phase (push branch):',
      `- Push the reviewed branch: \`git push -u origin ${branch}\`.`,
      `- Then emit exactly once: ${buildPhaseSignalTemplate('code-ready')}`,
      `  token: ${signalToken}`,
      '',
    ].join('\n');
  },
};

function buildServerReviewInstructions(
  { task, signalToken, serverContent, serverDiffstat, serverBatch, serverPriorFindings, serverPriorResponse, contentTruncated }: PhasePromptCtx,
  isRecheck: boolean,
): string {
  const round = task.reviewRound || 1;
  const batchLabel = serverBatch ? ` — Batch ${serverBatch.index + 1}/${serverBatch.total}` : '';
  const priorFindings = serverPriorFindings ? compactFindings(serverPriorFindings) : undefined;
  const priorResponse = serverPriorResponse ? compactFindings(serverPriorResponse) : undefined;
  return [
    `Server code ${isRecheck ? 'recheck' : 'review'} phase (round ${round})${batchLabel}:`,
    '- Review the diff injected below. Do NOT fetch branches or use gh; the diff is the review input.',
    ...(isRecheck
      ? [
          '- Prior findings and the dev response are included below. Verify every finding is closed (fixed with evidence, or convincingly rejected), then scan the new diff for regressions.',
        ]
      : []),
    ...(serverDiffstat ? ['', 'Changed files (full change scope):', serverDiffstat] : []),
    ...(contentTruncated
      ? ['- Content truncated. Request context via [bx:read-file:<path>:<start>-<end>] (relative path, ≤200 lines).']
      : []),
    '- Need file context beyond the diff? Emit [bx:read-file:<path>:<start>-<end>] on its own line and wait; baxian injects the content.',
    `- Write findings to ${REVIEW_EXCHANGE_DIR}/findings.json in YOUR worktree (\`mkdir -p ${REVIEW_EXCHANGE_DIR}\` first). Atomic write: write findings.json.tmp first, then \`mv findings.json.tmp findings.json\`.`,
    `- Schema: {"round":${round},"verdict":"approve"|"request-changes","findings":[{"id":"f-1","severity":"critical"|"major"|"minor","message":"...","file":"path","line":N}]}`,
    '- Approve MAY carry minor findings as suggestions; verdict field is authoritative.',
    `- Then emit exactly once: ${buildPhaseSignalTemplate('code-reviewed')}`,
    `  token: ${signalToken}`,
    ...(priorFindings
      ? ['', `prior findings${priorFindings.truncated ? ' [truncated]' : ''}:`, priorFindings.text]
      : []),
    ...(priorResponse
      ? ['', `dev response${priorResponse.truncated ? ' [truncated]' : ''}:`, priorResponse.text]
      : []),
    '',
    'diff:',
    serverContent ?? '',
    '',
  ].join('\n');
}

function buildTaskBody(args: TaskBodyArgs): string {
  const {
    task, phase, role, worktreePath, signalToken, postApproveRedispatchCount,
    currentSpecRound, imagePaths,
    serverContent, serverDiffstat, serverBatch,
    serverPriorFindings, serverPriorResponse, serverAfterDone, contentTruncated,
    hasQaPartner,
  } = args;
  const header = `Phase: ${phase}\nRole: ${role}\nTask ID: ${task.id}\nWorktree: ${worktreePath}\n` +
    `cd into the worktree before any file operations.\n\n`;
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
  const phaseInstructions = phaseBuilder({
    task, signalToken, currentSpecRound, postApproveRedispatchCount,
    serverContent, serverDiffstat, serverBatch,
    serverPriorFindings, serverPriorResponse, serverAfterDone, contentTruncated,
    hasQaPartner,
  });

  const titleAndBody = `Title: ${task.title}\n\n${task.description}`;
  const imagesBlock = imagePaths && imagePaths.length > 0
    ? '\n\n附图（baxian 已将用户上传的图片下载到 agent host，以下为绝对路径，请读取并结合任务分析）:\n' +
      imagePaths.map(p => `- ${p}`).join('\n')
    : '';
  const body = header + phaseInstructions + titleAndBody + imagesBlock;
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


export interface PostMergeCleanupContext {
  prNumber: number;
  taskId: string;
  branch: string;
}

export interface PostMergeBranchCleanupResult {
  outcome: 'deleted' | 'absent' | 'failed' | 'skipped';
  detail: string;
}

export function buildPostMergeCleanupPrompt(
  ctx: PostMergeCleanupContext,
  result: PostMergeBranchCleanupResult,
): string {
  const status = renderCleanupStatus(ctx.branch, result);
  return [
    `PR #${ctx.prNumber} (task ${ctx.taskId}, branch ${ctx.branch}) has merged.`,
    '',
    status,
    result.outcome === 'deleted' || result.outcome === 'absent'
      ? '`/clear` will follow automatically once your runtime is back at the REPL prompt — that gives the next task a clean context window.'
      : '`/compact` will follow automatically once your runtime is back at the REPL prompt — that is the compression step for this round\'s context.',
    '',
  ].join('\n');
}

function renderCleanupStatus(branch: string, result: PostMergeBranchCleanupResult): string {
  switch (result.outcome) {
    case 'deleted':
      return `baxian deleted the merged local feature branch \`${branch}\` from your repo clone (server-side via runner.exec).`;
    case 'absent':
      return `Local feature branch \`${branch}\` was already absent from your repo clone — nothing to clean up.`;
    case 'failed':
      return `WARNING: baxian failed to delete the local feature branch \`${branch}\`: ${result.detail || 'unknown error'}. ` +
        'Please clean it up manually (e.g. `git worktree prune && git branch -D ' + branch + '`) before the next task picks up this workspace.';
    case 'skipped':
      return `Local feature branch \`${branch}\` was not touched: ${result.detail || 'no repo path available'}.`;
  }
}

