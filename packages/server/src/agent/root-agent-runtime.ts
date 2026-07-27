import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { AgentRuntimeConfig, HostConfig, RootAgentConfig } from '../shared/index.js';
import { ROOT_AGENT_ID } from '../shared/index.js';
import type { PaneStreamerManager } from './pane-streamer-manager.js';
import { scanRootDoneSignals } from './phase-signal.js';
import { visibleText } from './vt-visible-text.js';
import {
  ancestorSymlinkGuard,
  canonicalSelfGuard,
  isUnder,
  moveFileIntoPlace,
  stageFileGuarded,
} from './repo-store.js';
import {
  ExecOutcomeUnknownError,
  execOutcomeUnknown,
  isTransientNetworkFailure,
} from './net-exec.js';
import {
  createRunner,
  mayShareHostAccount,
  resolveAgentHost,
  shellQuote,
  type CommandRunner,
} from './runner.js';
import { launchCommandIn } from './manager.js';
import {
  TmuxManager,
  PaneGoneError,
  TmuxOutcomeUnknownError,
  type PaneRef,
  type TmuxSessionRef,
} from './tmux.js';
import type { RootRecoveryRecord } from '../state/root-recovery-store.js';

export class RootPromptNotSubmittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RootPromptNotSubmittedError';
  }
}

export class RootAgentResponseInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RootAgentResponseInvalidError';
  }
}

export class RootAgentTerminationError extends Error {
  constructor(message: string, readonly hostConnectionUnknown: boolean) {
    super(message);
    this.name = 'RootAgentTerminationError';
  }
}

class RootMailboxPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RootMailboxPathError';
  }
}

export interface RootAgentRuntimePort {
  start(onSignal: (attemptToken: string) => void): Promise<void>;
  writeRequest(record: RootRecoveryRecord, body: string): Promise<void>;
  notify(record: RootRecoveryRecord): Promise<void>;
  readResponse(record: RootRecoveryRecord): Promise<unknown | null>;
  cleanup(record: RootRecoveryRecord): Promise<void>;
  isLive(): Promise<boolean>;
  invalidateStreamer(): Promise<void>;
  terminate(): Promise<void>;
  stop(): Promise<void>;
}

interface RootAgentRuntimeDeps {
  config: RootAgentConfig;
  hosts: () => HostConfig[];
  agents?: () => AgentRuntimeConfig[];
  paneStreamerManager: PaneStreamerManager;
  runnerFactory?: () => CommandRunner;
  tmuxFactory?: (runner: CommandRunner) => TmuxManager;
}

const ROOT_RUNTIME_DIR = '.baxian/root-agent';
const ROOT_INBOX_DIR = `${ROOT_RUNTIME_DIR}/inbox`;
export const ROOT_OUTBOX_DIR = `${ROOT_RUNTIME_DIR}/outbox`;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAILBOX_READ_TIMEOUT_MS = 10_000;
const RESPONSE_ABSENT = 'BX_ROOT_RESPONSE_ABSENT';
const MATCH_BUFFER_CHARS = 1024;
const ROOT_LAUNCH_COMMAND_OPTION = '@baxian-launch-command';

export class RootAgentRuntime implements RootAgentRuntimePort {
  private readonly config: RootAgentConfig;
  private readonly hosts: () => HostConfig[];
  private readonly agents: () => AgentRuntimeConfig[];
  private readonly paneStreamerManager: PaneStreamerManager;
  private readonly runnerFactory?: () => CommandRunner;
  private readonly tmuxFactory: (runner: CommandRunner) => TmuxManager;
  private physicalWorkdir?: string;
  private physicalHome?: string;
  private ensureChain: Promise<PaneRef> | null = null;
  private unsubscribe?: () => void;
  private onSignal?: (attemptToken: string) => void;
  private signalBuffer = '';
  private seenSignals = new Set<string>();

  constructor(deps: RootAgentRuntimeDeps) {
    this.config = deps.config;
    this.hosts = deps.hosts;
    this.agents = deps.agents ?? (() => []);
    this.paneStreamerManager = deps.paneStreamerManager;
    this.runnerFactory = deps.runnerFactory;
    this.tmuxFactory = deps.tmuxFactory ?? (runner => new TmuxManager(runner));
  }

  async start(onSignal: (attemptToken: string) => void): Promise<void> {
    this.onSignal = onSignal;
    await this.ensureSession();
    if (this.unsubscribe) return;
    const streamer = this.paneStreamerManager.ensure(this.runtimeConfig());
    const subscription = await streamer.subscribeAtomic({
      onVisible: visible => this.consumePaneData(visible),
      onSessionGone: () => {
        this.unsubscribe = undefined;
        this.signalBuffer = '';
      },
    });
    this.unsubscribe = subscription.unsubscribe;
    this.consumePaneData(visibleText(subscription.snapshot.data));
  }

  async writeRequest(record: RootRecoveryRecord, body: string): Promise<void> {
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error(`root recovery request ${record.id} exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    const { runner, workdir } = await this.mailboxContext();
    const final = `${workdir}/${ROOT_INBOX_DIR}/${record.id}.json`;
    const tmp = `${final}.tmp-${randomBytes(8).toString('hex')}`;
    await stageFileGuarded(runner, workdir, tmp, body, { mode: 0o600 });
    await moveFileIntoPlace(runner, tmp, final, { guardRoot: workdir });
  }

  async notify(record: RootRecoveryRecord): Promise<void> {
    let tmux: TmuxManager;
    let pane: PaneRef;
    let baseline: Awaited<ReturnType<TmuxManager['capturePaneSnapshot']>>;
    try {
      await this.start(this.onSignal ?? (() => undefined));
      const runner = this.createRunner();
      tmux = this.tmuxFactory(runner);
      pane = await this.resolveOwnedPane(tmux);
      await tmux.waitReplReady(pane, this.config.runtime, {
        timeoutMs: 30_000,
        scrollback: 0,
        titleIdleFastPath: true,
      });
      baseline = await tmux.capturePaneSnapshot(pane);
    } catch (err) {
      throw new RootPromptNotSubmittedError(
        `root prompt was not submitted: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await tmux.injectPrompt(pane, this.requestPrompt(record), ROOT_AGENT_ID);
      await tmux.sendEnter(pane);
    } catch (err) {
      if (err instanceof PaneGoneError) {
        throw new RootPromptNotSubmittedError(`root prompt was not submitted: ${err.message}`);
      }
      throw err;
    }
    await tmux.waitSubmitAck(pane, baseline, this.config.runtime, {
      timeoutMs: 30_000,
      acceptComposerChange: true,
      resend: () => tmux.sendEnter(pane),
    });
  }

  async readResponse(record: RootRecoveryRecord): Promise<unknown | null> {
    let context: { runner: CommandRunner; workdir: string };
    try {
      context = await this.mailboxContext();
    } catch (err) {
      if (err instanceof RootMailboxPathError) {
        throw new RootAgentResponseInvalidError(err.message);
      }
      throw err;
    }
    const { runner, workdir } = context;
    const target = `${workdir}/${ROOT_OUTBOX_DIR}/${record.id}.json`;
    const guard = ancestorSymlinkGuard(workdir, target);
    const command =
      `${guard} || exit 11; ` +
      `if [ -L ${shellQuote(target)} ]; then exit 9; fi; ` +
      `if [ ! -e ${shellQuote(target)} ]; then printf '%s' ${shellQuote(RESPONSE_ABSENT)}; exit 0; fi; ` +
      `[ -f ${shellQuote(target)} ] && [ ! -L ${shellQuote(target)} ] || exit 9; ` +
      `oversized=$(find ${shellQuote(target)} -prune -size +${MAX_RESPONSE_BYTES}c -print) || exit 9; ` +
      `[ -z "$oversized" ] || exit 10; ` +
      `cat ${shellQuote(target)}`;
    const result = await runner.exec(`sh -c ${shellQuote(command)}`, {
      timeout: MAILBOX_READ_TIMEOUT_MS,
      maxBuffer: MAX_RESPONSE_BYTES + 1,
    });
    if (result.exitCode !== 0 && execOutcomeUnknown(result)) {
      throw new ExecOutcomeUnknownError(
        `root response read outcome unknown for ${record.id}: ${result.stderr.trim()}`,
      );
    }
    if (result.exitCode === 9 || result.exitCode === 11) {
      throw new RootAgentResponseInvalidError(
        `root response path is unsafe or not a regular file: ${target}`,
      );
    }
    if (result.exitCode === 10) {
      throw new RootAgentResponseInvalidError(
        `root response ${target} exceeds ${MAX_RESPONSE_BYTES} bytes`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `root response read failed for ${record.id} (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    if (Buffer.byteLength(result.stdout, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new RootAgentResponseInvalidError(
        `root response ${target} exceeds ${MAX_RESPONSE_BYTES} bytes`,
      );
    }
    if (result.stdout === RESPONSE_ABSENT) return null;
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch (err) {
      throw new RootAgentResponseInvalidError(
        `root response ${target} is invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async cleanup(record: RootRecoveryRecord): Promise<void> {
    const { runner, workdir } = await this.mailboxContext();
    const targets = [
      `${workdir}/${ROOT_INBOX_DIR}/${record.id}.json`,
      `${workdir}/${ROOT_OUTBOX_DIR}/${record.id}.json`,
    ];
    const failures: string[] = [];
    for (const target of targets) {
      const command =
        `${ancestorSymlinkGuard(workdir, target)} && ` +
        `if [ -e ${shellQuote(target)} ] || [ -L ${shellQuote(target)} ]; then ` +
        `[ -f ${shellQuote(target)} ] && [ ! -L ${shellQuote(target)} ] || exit 9; ` +
        `rm -f -- ${shellQuote(target)} || exit 10; fi`;
      let result: Awaited<ReturnType<CommandRunner['exec']>>;
      try {
        result = await runner.exec(`sh -c ${shellQuote(command)}`);
      } catch (err) {
        const failure =
          `root mailbox cleanup probe failed for ${target}: ${err instanceof Error ? err.message : String(err)}`;
        throw new Error([...failures, failure].join('; '));
      }
      if (execOutcomeUnknown(result)) {
        const failure = `root mailbox cleanup outcome unknown for ${target}: ${result.stderr.trim()}`;
        throw new Error([...failures, failure].join('; '));
      } else if (result.exitCode === 9) {
        failures.push(`root mailbox cleanup refused unsafe target ${target} (exit 9)`);
      } else if (result.exitCode !== 0) {
        failures.push(
          `root mailbox cleanup failed for ${target} (exit ${result.exitCode}): ${result.stderr.trim()}`,
        );
      }
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
  }

  async isLive(): Promise<boolean> {
    const snapshot = await this.tmuxFactory(this.createRunner()).getSessionSnapshot(ROOT_AGENT_ID);
    return snapshot?.claim === ROOT_AGENT_ID;
  }

  async invalidateStreamer(): Promise<void> {
    try {
      this.unsubscribe?.();
    } finally {
      this.unsubscribe = undefined;
      this.signalBuffer = '';
      this.physicalWorkdir = undefined;
      this.physicalHome = undefined;
      await this.paneStreamerManager.destroy(ROOT_AGENT_ID);
    }
  }

  async terminate(): Promise<void> {
    const failures: Array<{ detail: string; hostConnectionUnknown: boolean }> = [];
    try {
      await this.invalidateStreamer();
    } catch (err) {
      failures.push({
        detail: `streamer cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        hostConnectionUnknown: false,
      });
    }
    try {
      const tmux = this.tmuxFactory(this.createRunner());
      const snapshot = await tmux.getSessionSnapshot(ROOT_AGENT_ID);
      if (snapshot && snapshot.claim !== ROOT_AGENT_ID) {
        failures.push({
          detail: `tmux session "${ROOT_AGENT_ID}" is not owned by baxian (claim=${snapshot.claim})`,
          hostConnectionUnknown: false,
        });
      } else if (snapshot) {
        const outcome = await tmux.killSessionRef(snapshot.ref, { kind: 'equals', claim: ROOT_AGENT_ID });
        if (outcome === 'refused') {
          failures.push({
            detail: 'tmux ownership changed while stopping root agent; session was kept',
            hostConnectionUnknown: false,
          });
        } else if (outcome === 'killed') {
          console.log(`[root-agent] stopped owned tmux session ${snapshot.ref.sessionId}`);
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      failures.push({
        detail: `tmux stop failed: ${detail}`,
        hostConnectionUnknown: err instanceof TmuxOutcomeUnknownError
          || isTransientNetworkFailure(detail),
      });
    }
    if (failures.length > 0) {
      throw new RootAgentTerminationError(
        failures.map(failure => failure.detail).join('; '),
        failures.every(failure => failure.hostConnectionUnknown),
      );
    }
  }

  async stop(): Promise<void> {
    await this.invalidateStreamer();
  }

  private ensureSession(): Promise<PaneRef> {
    if (this.ensureChain) return this.ensureChain;
    const pending = this.ensureSessionOnce();
    this.ensureChain = pending;
    void pending.finally(() => {
      if (this.ensureChain === pending) this.ensureChain = null;
    }).catch(() => undefined);
    return pending;
  }

  private async ensureSessionOnce(): Promise<PaneRef> {
    const { runner, workdir } = await this.mailboxContext();
    const tmux = this.tmuxFactory(runner);
    const snapshot = await tmux.getSessionSnapshot(ROOT_AGENT_ID);
    if (!snapshot) return this.createSession(tmux, workdir);
    if (snapshot.claim !== ROOT_AGENT_ID) {
      throw new Error(
        `tmux session "${ROOT_AGENT_ID}" exists but is not owned by baxian ` +
        `(claim=${snapshot.claim ?? 'empty'}); choose another host or remove it manually`,
      );
    }
    const pane = await tmux.getSinglePaneByRef(snapshot.ref, ROOT_AGENT_ID);
    const currentPath = await tmux.getPaneCurrentPath(pane);
    if (!(await this.samePhysicalPath(runner, currentPath, workdir))) {
      throw new Error(
        `root agent pane Workdir changed (${currentPath} != ${workdir}); baxian will not replace the live session`,
      );
    }
    const state = await tmux.classifyPaneForAdopt(pane, this.config.runtime);
    if (state.kind === 'other') {
      throw new Error(
        `root agent pane foreground "${state.paneCurrentCommand}" is neither the configured runtime nor a shell`,
      );
    }
    if (state.kind === 'startup-dialog') {
      throw new Error('root agent runtime is blocked on a startup dialog; attach and dismiss it');
    }
    const launchCommand = launchCommandIn(workdir, this.runtimeConfig());
    if (state.kind !== 'shell') {
      const recorded = await tmux.getSessionOptionByRef(
        snapshot.ref,
        ROOT_AGENT_ID,
        ROOT_LAUNCH_COMMAND_OPTION,
      );
      if (recorded === null) {
        throw new Error(
          'root agent session predates launch-command tracking; stop root-agent once to relaunch it with verified configuration',
        );
      }
      if (recorded !== launchCommand) {
        throw new Error(
          'root agent launch configuration differs from the running session; stop root-agent before applying model or permission changes',
        );
      }
    }
    await this.setSessionOptions(tmux, snapshot.ref, [
      ['@baxian-runtime', this.config.runtime],
      ['@baxian-workdir', workdir],
      [ROOT_LAUNCH_COMMAND_OPTION, launchCommand],
    ]);
    if (state.kind === 'live-runtime') return pane;
    if (state.kind === 'trust-dialog') {
      await tmux.handleTrustDialog(pane, this.config.runtime, { timeoutMs: 10_000 });
    } else {
      await tmux.sendKeysLiteral(pane, launchCommand);
      await tmux.sendEnter(pane);
    }
    await tmux.waitReplReady(pane, this.config.runtime, { timeoutMs: 30_000, scrollback: 0 });
    return pane;
  }

  private async createSession(tmux: TmuxManager, workdir: string): Promise<PaneRef> {
    let ref: TmuxSessionRef | undefined;
    try {
      ref = await tmux.createSession(ROOT_AGENT_ID, workdir);
      const launchCommand = launchCommandIn(workdir, this.runtimeConfig());
      const applied = await tmux.setSessionOptionsIfAlive(ref, [
        ['@baxian-agent-id', ROOT_AGENT_ID],
        ['@baxian-runtime', this.config.runtime],
        ['@baxian-workdir', workdir],
        [ROOT_LAUNCH_COMMAND_OPTION, launchCommand],
        ['allow-passthrough', 'on'],
        ['set-titles', 'on'],
        ['window-size', 'latest'],
        ['status-right', ''],
      ], { expectedClaim: '' });
      if (applied === 'gone') throw new Error('root agent tmux session vanished during initialization');
      await tmux.setServerOption('extended-keys', 'on');
      await tmux.appendServerOptionIfMissing('terminal-features', 'xterm*:extkeys');
      const pane = await tmux.getSinglePaneByRef(ref, ROOT_AGENT_ID);
      await tmux.sendKeysLiteral(pane, launchCommand);
      await tmux.sendEnter(pane);
      await tmux.handleTrustDialog(pane, this.config.runtime, { timeoutMs: 10_000 });
      await tmux.waitReplReady(pane, this.config.runtime, { timeoutMs: 30_000, scrollback: 0 });
      return pane;
    } catch (err) {
      if (ref) {
        try {
          const outcome = await tmux.killSessionRef(ref, { kind: 'emptyOr', claim: ROOT_AGENT_ID });
          if (outcome === 'killed') {
            console.warn(`[root-agent] rolled back newly created tmux session after startup failure`);
          } else if (outcome === 'refused') {
            console.warn('[root-agent] startup rollback refused because tmux ownership changed; session kept');
          }
        } catch (cleanupErr) {
          console.warn('[root-agent] startup rollback could not confirm cleanup:', cleanupErr);
        }
      }
      throw err;
    }
  }

  private async resolveOwnedPane(tmux: TmuxManager): Promise<PaneRef> {
    const snapshot = await tmux.getSessionSnapshot(ROOT_AGENT_ID);
    if (!snapshot || snapshot.claim !== ROOT_AGENT_ID) {
      throw new Error(`root agent tmux session is absent or ownership changed`);
    }
    return tmux.getSinglePaneByRef(snapshot.ref, ROOT_AGENT_ID);
  }

  private async mailboxContext(): Promise<{ runner: CommandRunner; workdir: string }> {
    const runner = this.createRunner();
    const workdir = await this.resolveWorkdir(runner);
    await this.ensureMailboxDirs(runner, workdir);
    return { runner, workdir };
  }

  private async resolveWorkdir(runner: CommandRunner): Promise<string> {
    if (this.physicalWorkdir) {
      await this.assertWorkdirIsolation(runner, this.physicalWorkdir);
      return this.physicalWorkdir;
    }
    const result = await runner.exec(
      `cd -- ${shellQuote(this.config.workdir)} 2>/dev/null && pwd -P`,
    );
    if (execOutcomeUnknown(result)) {
      throw new ExecOutcomeUnknownError(`root Workdir probe outcome unknown: ${result.stderr.trim()}`);
    }
    const physical = result.stdout.trim().replace(/\/+$/, '') || '/';
    if (result.exitCode !== 0 || !physical.startsWith('/')) {
      throw new Error(
        `root.workdir ${this.config.workdir} does not exist or is not accessible; create it explicitly`,
      );
    }
    await this.assertWorkdirIsolation(runner, physical);
    this.physicalWorkdir = physical;
    return physical;
  }

  private async assertWorkdirIsolation(runner: CommandRunner, rootWorkdir: string): Promise<void> {
    const rootHost = resolveAgentHost(this.hosts(), this.config.host);
    const peerAgents = this.agents().filter(agent => {
      const agentHost = resolveAgentHost(this.hosts(), agent.host);
      return mayShareHostAccount(this.config.mode, rootHost, agent.mode, agentHost);
    });
    for (const agent of peerAgents) {
      if (agent.yolo !== false) {
        throw new RootMailboxPathError(
          `root mailbox cannot share an OS account with yolo agent ${agent.id}; ` +
          'configure yolo: false or use a different explicit SSH user or hostname',
        );
      }
      const configuredWorkdir = agent.workdir;
      const workdir = configuredWorkdir
        ?? `${await this.resolveDefaultAgentHome(runner)}/.baxian/agents/${agent.id}/repo`;
      const physicalWorkdir = await this.resolvePeerPhysicalPath(runner, agent, 'Workdir', workdir);
      this.assertPeerPathIsolated(agent, 'Workdir', workdir, physicalWorkdir, rootWorkdir);
      for (const addDir of agent.addDirs ?? []) {
        const path = posix.isAbsolute(addDir)
          ? addDir
          : posix.resolve(physicalWorkdir, addDir);
        const physical = await this.resolvePeerPhysicalPath(runner, agent, 'addDir', path);
        this.assertPeerPathIsolated(agent, 'addDir', path, physical, rootWorkdir);
      }
    }
  }

  private async resolvePeerPhysicalPath(
    runner: CommandRunner,
    agent: AgentRuntimeConfig,
    kind: 'Workdir' | 'addDir',
    path: string,
  ): Promise<string> {
    const result = await runner.exec(
      `cd -- ${shellQuote(path)} 2>/dev/null && pwd -P`,
    );
    if (execOutcomeUnknown(result)) {
      throw new ExecOutcomeUnknownError(
        `agent ${agent.id} ${kind} probe outcome unknown while validating root.workdir: ${result.stderr.trim()}`,
      );
    }
    if (result.exitCode !== 0) {
      return this.resolveProspectivePeerPath(runner, agent, kind, path);
    }
    const physical = result.stdout.trim().replace(/\/+$/, '') || '/';
    if (!physical.startsWith('/')) {
      throw new Error(
        `cannot resolve agent ${agent.id} ${kind} ${path} while validating root.workdir`,
      );
    }
    return physical;
  }

  private async resolveProspectivePeerPath(
    runner: CommandRunner,
    agent: AgentRuntimeConfig,
    kind: 'Workdir' | 'addDir',
    path: string,
  ): Promise<string> {
    const command = [
      `bx_path=${shellQuote(posix.normalize(path))}`,
      'bx_suffix=\'\'',
      'while [ ! -e "$bx_path" ] && [ ! -L "$bx_path" ]; do ' +
        '[ "$bx_path" != / ] || exit 12; ' +
        'bx_name=${bx_path##*/}; ' +
        'bx_suffix="/$bx_name$bx_suffix"; ' +
        'bx_path=${bx_path%/*}; ' +
        '[ -n "$bx_path" ] || bx_path=/; ' +
        'done',
      'cd -- "$bx_path" 2>/dev/null',
      'bx_prefix=$(pwd -P)',
      'case "$bx_prefix" in /) bx_prefix=\'\';; esac',
      'printf \'%s%s\' "$bx_prefix" "$bx_suffix"',
    ].join(' && ');
    const result = await runner.exec(command);
    if (execOutcomeUnknown(result)) {
      throw new ExecOutcomeUnknownError(
        `agent ${agent.id} missing ${kind} probe outcome unknown while validating root.workdir: ` +
        result.stderr.trim(),
      );
    }
    const physical = result.stdout.trim().replace(/\/+$/, '') || '/';
    if (result.exitCode !== 0 || !physical.startsWith('/')) {
      throw new Error(
        `agent ${agent.id} ${kind} ${path} does not exist and its future physical path ` +
        'cannot be resolved safely while validating root.workdir',
      );
    }
    return physical;
  }

  private assertPeerPathIsolated(
    agent: AgentRuntimeConfig,
    kind: 'Workdir' | 'addDir',
    path: string,
    physical: string,
    rootWorkdir: string,
  ): void {
    if (!physicalPathsOverlap(physical, rootWorkdir)) return;
    const relation = physical === rootWorkdir
      ? `resolve to the same physical directory ${rootWorkdir}`
      : `overlap as physical directories ${physical} and ${rootWorkdir}`;
    throw new RootMailboxPathError(
      `root.workdir ${this.config.workdir} and agent ${agent.id} ${kind} ${path} ${relation}`,
    );
  }

  private async resolveDefaultAgentHome(runner: CommandRunner): Promise<string> {
    if (this.physicalHome) return this.physicalHome;
    const target = this.config.mode === 'local' ? shellQuote(homedir()) : '"$HOME"';
    const result = await runner.exec(`cd -- ${target} 2>/dev/null && pwd -P`);
    if (execOutcomeUnknown(result)) {
      throw new ExecOutcomeUnknownError(`default agent home probe outcome unknown: ${result.stderr.trim()}`);
    }
    const physical = result.stdout.trim().replace(/\/+$/, '') || '/';
    if (result.exitCode !== 0 || !physical.startsWith('/')) {
      throw new Error(`cannot resolve the default agent home while validating root.workdir`);
    }
    this.physicalHome = physical;
    return physical;
  }

  private async ensureMailboxDirs(runner: CommandRunner, workdir: string): Promise<void> {
    const dirs = [
      `${workdir}/.baxian`,
      `${workdir}/${ROOT_RUNTIME_DIR}`,
      `${workdir}/${ROOT_INBOX_DIR}`,
      `${workdir}/${ROOT_OUTBOX_DIR}`,
    ];
    const ancestors = ['/'];
    let ancestor = '';
    for (const part of workdir.split('/').filter(Boolean)) {
      ancestor += `/${part}`;
      ancestors.push(ancestor);
    }
    const statFunction =
      'bx_stat() { ' +
      'stat -c \'%u %a\' -- "$1" 2>/dev/null || stat -f \'%u %Mp%03Lp\' "$1" 2>/dev/null; ' +
      '}';
    const trustChain =
      `for bx_path in ${ancestors.map(shellQuote).join(' ')}; do ` +
      '[ -d "$bx_path" ] && [ ! -L "$bx_path" ] || { ' +
      'printf \'unsafe root Workdir ancestor: %s\\n\' "$bx_path" >&2; exit 11; }; ' +
      'bx_meta=$(bx_stat "$bx_path") || { ' +
      'printf \'cannot inspect root Workdir ancestor: %s\\n\' "$bx_path" >&2; exit 11; }; ' +
      'bx_owner=${bx_meta%% *}; bx_mode=${bx_meta#* }; ' +
      'case "$bx_owner" in \'\'|*[!0-9]*) exit 11;; esac; ' +
      'case "$bx_mode" in \'\'|*[!0-7]*) exit 11;; esac; ' +
      '[ "$bx_owner" = "$bx_uid" ] || [ "$bx_owner" = 0 ] || { ' +
      'printf \'untrusted owner for root Workdir ancestor: %s\\n\' "$bx_path" >&2; exit 11; }; ' +
      'bx_permissions=$((0$bx_mode)); ' +
      'if [ $((bx_permissions & 0022)) -ne 0 ] && [ $((bx_permissions & 01000)) -eq 0 ]; then ' +
      'printf \'root Workdir ancestor is writable by other users: %s\\n\' "$bx_path" >&2; exit 11; fi; ' +
      'done';
    const preflight = dirs.map(path =>
      `${ancestorSymlinkGuard(workdir, path)} && ` +
      `{ [ ! -e ${shellQuote(path)} ] || { [ -d ${shellQuote(path)} ] && [ ! -L ${shellQuote(path)} ]; }; }`,
    );
    const verify = dirs.map(path => `[ -d ${shellQuote(path)} ] && [ ! -L ${shellQuote(path)} ]`);
    const verifyOwnership =
      `for bx_path in ${dirs.map(shellQuote).join(' ')}; do ` +
      'bx_meta=$(bx_stat "$bx_path") || exit 11; ' +
      'bx_owner=${bx_meta%% *}; bx_mode=${bx_meta#* }; ' +
      'case "$bx_owner" in \'\'|*[!0-9]*) exit 11;; esac; ' +
      'case "$bx_mode" in \'\'|*[!0-7]*) exit 11;; esac; ' +
      'bx_permissions=$((0$bx_mode)); ' +
      '[ "$bx_owner" = "$bx_uid" ] && [ "$bx_permissions" -eq $((0700)) ] || { ' +
      'printf \'root mailbox directory is not private and owner-controlled: %s\\n\' "$bx_path" >&2; exit 11; }; ' +
      'done';
    const command = [
      `${canonicalSelfGuard(workdir)} || exit 11`,
      statFunction,
      'bx_uid=$(id -u) || exit 11',
      trustChain,
      `${preflight.join(' && ')} || exit 11`,
      'umask 077',
      `mkdir -p ${dirs.map(shellQuote).join(' ')} || exit 10`,
      `chmod 700 ${dirs.map(shellQuote).join(' ')} || exit 10`,
      `${verify.join(' && ')} || exit 11`,
      verifyOwnership,
    ].join('; ');
    const result = await runner.exec(`sh -c ${shellQuote(command)}`);
    if (execOutcomeUnknown(result)) {
      throw new ExecOutcomeUnknownError(
        `root mailbox directory creation outcome unknown: ${result.stderr.trim()}`,
      );
    }
    if (result.exitCode === 11) {
      throw new RootMailboxPathError(
        `root mailbox requires an owner-controlled canonical Workdir and real private directories under ${workdir}: ` +
        `${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `root mailbox directory creation failed under ${workdir}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
  }

  private async samePhysicalPath(runner: CommandRunner, left: string, right: string): Promise<boolean> {
    if (left.replace(/\/+$/, '') === right.replace(/\/+$/, '')) return true;
    const result = await runner.exec(`cd -- ${shellQuote(left)} 2>/dev/null && pwd -P`);
    if (execOutcomeUnknown(result)) {
      throw new ExecOutcomeUnknownError(`root pane path probe outcome unknown: ${result.stderr.trim()}`);
    }
    return result.exitCode === 0 && result.stdout.trim().replace(/\/+$/, '') === right.replace(/\/+$/, '');
  }

  private async setSessionOptions(
    tmux: TmuxManager,
    ref: TmuxSessionRef,
    entries: Array<[string, string]>,
  ): Promise<void> {
    const outcome = await tmux.setSessionOptionsIfAlive(ref, entries, { expectedClaim: ROOT_AGENT_ID });
    if (outcome === 'gone') throw new Error('root agent tmux session vanished while updating options');
  }

  private runtimeConfig(): AgentRuntimeConfig {
    return {
      id: ROOT_AGENT_ID,
      runtime: this.config.runtime,
      mode: this.config.mode,
      ...(this.config.host !== undefined ? { host: this.config.host } : {}),
      workdir: this.config.workdir,
      yolo: this.config.yolo,
      ...(this.config.model !== undefined ? { model: this.config.model } : {}),
    };
  }

  private createRunner(): CommandRunner {
    return this.runnerFactory?.()
      ?? createRunner(this.config.mode, resolveAgentHost(this.hosts(), this.config.host));
  }

  private requestPrompt(record: RootRecoveryRecord): string {
    const workdir = this.physicalWorkdir ?? this.config.workdir;
    const requestPath = `${workdir}/${ROOT_INBOX_DIR}/${record.id}.json`;
    const responsePath = `${workdir}/${ROOT_OUTBOX_DIR}/${record.id}.json`;
    return [
      '你是 Baxian root agent。Server 的正常 task 状态机仍是主流程；你只处理这一次卡住恢复请求。',
      '禁止调用 Baxian MCP、REST API 或直接修改 task 状态。只允许根据请求中的证据选择一个 allowedDecisions 动作。',
      `读取请求文件：${requestPath}`,
      '输出必须是严格 JSON：',
      `{"version":1,"requestId":"${record.id}","attemptToken":"${record.attemptToken}","decision":{"action":"<allowed-action>","reason":"..."}}`,
      `先写同目录唯一 tmp 文件，确认目标不是目录后再原子 mv 到：${responsePath}`,
      '写完后在助手回复中单独输出 [bx:root-done:<attemptToken>]，把占位符替换为请求中的 attemptToken。不要用 shell echo/printf 发送 signal。',
      '一次只返回一个决策；不要执行该决策，Server 会校验并执行。',
    ].join('\n');
  }

  // `data` is visible text — decoded by PaneStreamer (live) or at the call site (snapshot).
  private consumePaneData(data: string): void {
    const combined = this.signalBuffer + data;
    for (const token of scanRootDoneSignals(combined)) {
      if (this.seenSignals.has(token)) continue;
      this.seenSignals.add(token);
      if (this.seenSignals.size > 256) {
        const oldest = this.seenSignals.values().next().value;
        if (oldest !== undefined) this.seenSignals.delete(oldest);
      }
      try {
        this.onSignal?.(token);
      } catch (err) {
        console.warn('[root-agent] signal callback failed:', err);
      }
    }
    this.signalBuffer = combined.slice(-MATCH_BUFFER_CHARS);
  }
}

function physicalPathsOverlap(left: string, right: string): boolean {
  return left === right || isUnder(left, right) || isUnder(right, left);
}
