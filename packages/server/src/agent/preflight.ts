import type { CommandRunner, RemoteShellMode } from './runner.js';
import { LocalRunner, buildSshOptions, ensureMuxDir, shellQuote, sshTarget, sshEnv } from './runner.js';
import { ancestorSymlinkGuard } from './repo-store.js';
import { GH_EXEC_TIMEOUT_MS, GIT_NET_ENV, execNetwork, execOutcomeUnknown } from './net-exec.js';
import type { AgentConfig, AgentRuntime, HostConfig } from '../shared/index.js';
import { isGitHubRepo, parseGitRemote, redactGitCredentials, repoSlug } from '../shared/index.js';
import { runDriverPreflightSteps, type DriverPreflightStep } from '../platform/preflight-exec.js';
import type { RenderContext } from '../platform/command-renderer.js';
import { safeDriverErrorText } from '../platform/git-driver.js';

export interface PreflightResult {
  step: string;
  ok: boolean;
  message: string;
}

export interface AgentGitPreflight {
  tool: string;
  minToolVersion: string;
  steps: readonly DriverPreflightStep[];
  agentCommands: readonly string[][];
  renderCtx: RenderContext;
  driverFor: (
    exec: (cmd: string, opts: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
  ) => { runOp(opName: string): Promise<Array<Record<string, unknown>>> };
}

const CLI_BINARY: Record<AgentRuntime, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  qodercli: 'qodercli',
};

const PREFLIGHT_PROBE_TIMEOUT_MS = 5000;

const PREFLIGHT_NET = { timeout: GH_EXEC_TIMEOUT_MS, retries: 0 } as const;

async function probeNetwork(
  runner: CommandRunner,
  cmd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    return await execNetwork(runner, cmd, PREFLIGHT_NET);
  } catch (err) {
    return { stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 124 };
  }
}

export function lastNonEmptyLine(s: string): string {
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return '';
}

async function probeBinary(
  runner: CommandRunner,
  binary: string,
  step: string,
  okMessage: (path: string) => string,
  failMessage: string,
  options: { remoteShell?: RemoteShellMode } = {},
): Promise<PreflightResult> {
  try {
    const result = await runner.exec(`command -v ${binary}`, {
      ...options,
      timeout: PREFLIGHT_PROBE_TIMEOUT_MS,
    });
    const path = lastNonEmptyLine(result.stdout);
    if (result.exitCode === 0 && path) {
      return { step, ok: true, message: okMessage(path) };
    }
    return { step, ok: false, message: failMessage };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      step,
      ok: false,
      message: /timed out/i.test(msg)
        ? `${binary} probe timed out after ${PREFLIGHT_PROBE_TIMEOUT_MS}ms`
        : `${binary} probe failed: ${msg}`,
    };
  }
}

export function tmuxInstallHint(projectId?: string): string {
  return `run "baxian check ${projectId ?? '<project>'} --fix" to install it automatically`;
}

export function probeTmux(runner: CommandRunner, projectId?: string): Promise<PreflightResult> {
  return probeBinary(
    runner,
    'tmux',
    'tmux',
    (path) => `tmux found at ${path}`,
    `Please install tmux on the agent host, or ${tmuxInstallHint(projectId)}`,
  );
}

export async function runPreflight(
  runner: CommandRunner,
  agent: AgentConfig,
  repo: string,
  host?: HostConfig,
  projectId?: string,
  gitPlatform?: AgentGitPreflight,
  options: { requireGitPush?: boolean } = {},
): Promise<PreflightResult[]> {
  repo = repo.trim();
  const results: PreflightResult[] = [];
  const binary = CLI_BINARY[agent.runtime];

  if (agent.mode === 'remote') {
    if (!host) {
      results.push({ step: 'ssh', ok: false, message: 'Remote agent missing host config' });
      return results;
    }
    const target = sshTarget(host);
    await ensureMuxDir();
    const sshCmd = `ssh ${buildSshOptions(host, { noMux: true })} -- ${shellQuote(target)} echo ok`;
    const env = await sshEnv(host);
    const sshCheck = await new LocalRunner().exec(sshCmd, Object.keys(env).length ? { env } : {});
    results.push({
      step: 'ssh',
      ok: sshCheck.exitCode === 0 && sshCheck.stdout.includes('ok'),
      message: sshCheck.exitCode === 0
        ? `SSH to ${target} OK`
        : `Cannot reach ${target} via SSH; check ${host.password ? 'password' : 'key auth'} and reachability`,
    });
    if (sshCheck.exitCode !== 0) return results;
  }

  results.push(
    await probeBinary(
      runner,
      binary,
      'cli',
      (path) => `${binary} found at ${path}`,
      `Please install ${agent.runtime} CLI (${binary})`,
      { remoteShell: 'login-interactive' },
    ),
  );

  results.push(await probeTmux(runner, projectId));

  const isAuto = !agent.workdir;
  let lsRemote: LsRemoteTarget = { skip: true };
  const probe = await gitLsRemoteProbeUrl(runner, repo, agent, gitPlatform, {
    requirePush: options.requireGitPush === true,
  });
  if ('error' in probe) {
    results.push({
      step: 'git',
      ok: false,
      message: `cannot determine the fetch/push/clone channel on this host: ${probe.error}`,
    });
  } else {
    lsRemote = { urls: probe.urls };
  }
  if (isAuto) {
    await runAutoModePreflight(runner, agent.id, repo, results, lsRemote);
  } else {
    await runManualModePreflight(runner, agent.workdir!, repo, results, lsRemote);
  }

  if (gitPlatform !== undefined) {
    await runGitPlatformChecks(runner, agent, gitPlatform, results);
  } else if (isGitHubRepo(repo) && isAuto) {
    const slug = repoSlug(repo);
    const ghCheck = await probeNetwork(runner, 'gh auth status');
    const ghOutcomeUnknown = ghCheck.exitCode === 124 || execOutcomeUnknown(ghCheck);
    results.push({
      step: 'gh',
      ok: ghCheck.exitCode === 0 && !ghOutcomeUnknown,
      message: ghCheck.exitCode === 0 && !ghOutcomeUnknown
        ? 'GitHub CLI authenticated'
        : ghOutcomeUnknown
          ? 'Could not verify GitHub CLI authentication because the probe outcome is unknown — check network connectivity and retry'
          : 'Run "gh auth login" or set GITHUB_TOKEN',
    });

    const ghRepoCheck = await probeNetwork(runner, `gh api repos/${slug}`);
    results.push({
      step: 'gh-repo',
      ok: ghRepoCheck.exitCode === 0,
      message: ghRepoCheck.exitCode === 0
        ? `gh api access to ${slug} OK`
        : `gh api repos/${slug} failed — check token scopes`,
    });
  }

  return results;
}

async function gitLsRemoteProbeUrl(
  runner: CommandRunner,
  repo: string,
  agent: AgentConfig,
  git?: AgentGitPreflight,
  options: { requirePush: boolean } = { requirePush: false },
): Promise<{ urls: string[] } | { error: string }> {
  const read = async (cmd: string): Promise<{ value: string; lines: string[] } | { error: string }> => {
    try {
      const res = await runner.exec(cmd, { timeout: PREFLIGHT_PROBE_TIMEOUT_MS });
      if (execOutcomeUnknown(res)) {
        return { error: `${cmd} exited ${res.exitCode}: ${lastNonEmptyLine(res.stderr) || 'transport failure'}` };
      }
      const lines = res.exitCode === 0
        ? res.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
        : [];
      return { value: lines.length > 0 ? lines[lines.length - 1] : '', lines };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  if (agent.workdir !== undefined) {
    const fetchOrigin = await read(`cd ${shellQuote(agent.workdir)} && git remote get-url origin`);
    if ('error' in fetchOrigin) return fetchOrigin;
    if (fetchOrigin.value === '') {
      return { error: `no origin configured in ${agent.workdir} — fetch/checkout would fail` };
    }
    const urls = [fetchOrigin.value];
    if (options.requirePush) {
      const pushOrigin = await read(
        `cd ${shellQuote(agent.workdir)} && git remote get-url --push --all origin`,
      );
      if ('error' in pushOrigin) return pushOrigin;
      if (pushOrigin.lines.length === 0) {
        return { error: `no push origin configured in ${agent.workdir} — publish would fail` };
      }
      urls.push(...pushOrigin.lines);
    }
    return { urls: [...new Set(urls)] };
  }
  if ((git !== undefined && git.tool !== 'gh') || !isGitHubRepo(repo)) return { urls: [repo] };
  const slug = repoSlug(repo);
  const hostname = git?.renderCtx.hostname ?? parseGitRemote(repo)?.host ?? 'github.com';
  const hostScoped = await read(`gh config get -h ${shellQuote(hostname)} git_protocol`);
  if ('error' in hostScoped) return hostScoped;
  let protocol = hostScoped.value;
  if (protocol === '') {
    const globalCfg = await read('gh config get git_protocol');
    if ('error' in globalCfg) return globalCfg;
    protocol = globalCfg.value;
  }
  if (protocol === '') protocol = 'https';
  return {
    urls: [protocol === 'ssh' ? `git@${hostname}:${slug}.git` : `https://${hostname}/${slug}.git`],
  };
}

async function runGitPlatformChecks(
  runner: CommandRunner,
  agent: AgentConfig,
  git: AgentGitPreflight,
  results: PreflightResult[],
): Promise<void> {
  const ctx = { ...git.renderCtx, binary: git.tool, minToolVersion: git.minToolVersion };
  const stepResults = await runDriverPreflightSteps((cmd) => probeNetwork(runner, cmd), git.steps, ctx);
  results.push(...stepResults);
  if (stepResults.some((s) => !s.ok)) return;

  const runsPlatformWrites = agent.role === 'dev';
  if (runsPlatformWrites && git.agentCommands.length > 0) {
    const missing: string[] = [];
    const probeErrors: string[] = [];
    for (const group of git.agentCommands) {
      let satisfied = false;
      const groupErrors: string[] = [];
      for (const cmd of group) {
        try {
          const probe = await runner.exec(`command -v ${cmd}`, { timeout: PREFLIGHT_PROBE_TIMEOUT_MS });
          if (probe.exitCode === 0 && lastNonEmptyLine(probe.stdout) !== '') {
            satisfied = true;
            break;
          }
        } catch (err) {
          groupErrors.push(`${cmd}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!satisfied) {
        missing.push(group.join(' or '));
        probeErrors.push(...groupErrors);
      }
    }
    const detail = probeErrors.length > 0 ? ` (probe failures: ${probeErrors.join('; ')})` : '';
    results.push(missing.length === 0 && probeErrors.length === 0
      ? { step: 'platform-skill-deps', ok: true, message: 'all commands declared by the platform skill are available' }
      : {
        step: 'platform-skill-deps',
        ok: false,
        message: missing.length === 0
          ? `could not verify the commands required by the platform skill${detail}`
          : `missing command(s) required by the platform skill: ${missing.join(', ')} — install them on this host${detail}`,
      });
  }

  const driver = git.driverFor(async (cmd, opts) => {
    try {
      return await execNetwork(runner, cmd, { timeout: opts.timeout, retries: 0 });
    } catch (err) {
      return { stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 124 };
    }
  });
  let row: Record<string, unknown> | undefined;
  try {
    [row] = await driver.runOp('projectView');
  } catch (err) {
    console.warn('[preflight] projectView failed:', safeDriverErrorText(err));
    results.push({
      step: 'platform-repo',
      ok: false,
      message: `driver projectView on ${git.renderCtx.repoPath} failed — check the ${git.tool} credentials and repo authorization on this host (${safeDriverErrorText(err)})`,
    });
    return;
  }
  results.push({
    step: 'platform-repo',
    ok: true,
    message: `driver projectView on ${git.renderCtx.repoPath} OK`,
  });

  const push = row?.pushPermitted;
  if (push === true) {
    results.push({ step: 'platform-push', ok: true, message: 'push permission confirmed' });
  } else if (push === false) {
    results.push(agent.role === 'dev'
      ? {
        step: 'platform-push',
        ok: false,
        message: 'repo is readable but push is not permitted — dev publish requires push access',
      }
      : {
        step: 'platform-push',
        ok: true,
        message: 'read access OK; push is not required for QA (PR write scope cannot be probed statically — deploy credentials must include it)',
      });
  } else {
    results.push({
      step: 'platform-push',
      ok: true,
      message: 'plugin did not report pushPermitted — write access cannot be asserted statically',
    });
  }
}

type LsRemoteTarget = { urls: string[] } | { skip: true };

async function runManualModePreflight(
  runner: CommandRunner,
  workdir: string,
  repo: string,
  results: PreflightResult[],
  lsRemote: LsRemoteTarget,
): Promise<void> {
  const workdirCheck = await runner.exec(
    `cd ${shellQuote(workdir)} && ` +
    `test "$(pwd -P)" = "$(cd "$(git rev-parse --show-toplevel)" && pwd -P)" && ` +
    `test "$(git rev-parse --is-bare-repository)" = false && ` +
    `test -d .git && test "$(git rev-parse --git-common-dir)" = .git && ` +
    `test ! -s .git/objects/info/alternates`,
  );
  results.push({
    step: 'workdir',
    ok: workdirCheck.exitCode === 0,
    message: workdirCheck.exitCode === 0
      ? `${workdir} is an independent ordinary Git clone root`
      : `${workdir} is not accessible or is not an independent ordinary Git clone root`,
  });

  if ('skip' in lsRemote) return;
  const targets = lsRemote.urls;
  const failed: string[] = [];
  for (const url of targets) {
    const check = await probeNetwork(runner, `${GIT_NET_ENV} git ls-remote ${shellQuote(url)} HEAD`);
    if (check.exitCode !== 0) failed.push(redactGitCredentials(url));
  }
  results.push({
    step: 'git',
    ok: failed.length === 0,
    message: failed.length === 0
      ? 'Git repository accessible'
      : `Cannot access ${failed.join(', ')} — check SSH key or HTTPS credentials`,
  });
}

async function runAutoModePreflight(
  runner: CommandRunner,
  agentId: string,
  repo: string,
  results: PreflightResult[],
  lsRemote: LsRemoteTarget,
): Promise<void> {
  const gh = isGitHubRepo(repo);
  const homeProbe = await runner.exec('cd ~ && pwd -P');
  const home = homeProbe.stdout.trim();
  if (homeProbe.exitCode !== 0 || home === '') {
    results.push({
      step: 'workdir',
      ok: false,
      message: `Cannot resolve physical home: ${homeProbe.stderr || homeProbe.stdout}`,
    });
    return;
  }
  const root = `${home}/.baxian/agents/${agentId}`;
  const absRepoPath = `${root}/repo`;
  const mk = await runner.exec(`${ancestorSymlinkGuard(home, root)} && mkdir -p ${shellQuote(root)} && test -w ${shellQuote(root)}`);
  if (mk.exitCode !== 0) {
    results.push({
      step: 'workdir',
      ok: false,
      message: `Cannot create or write to ${root} (symlink-safe): ${mk.stderr || mk.stdout}`,
    });
    return;
  }

  const dirCheck = await runner.exec(`test -d ${shellQuote(absRepoPath)}`);
  if (dirCheck.exitCode === 0) {
    const gitCheck = await runner.exec(
      `cd ${shellQuote(absRepoPath)} && ` +
      `test "$(pwd -P)" = "$(cd "$(git rev-parse --show-toplevel)" && pwd -P)" && ` +
      `test "$(git rev-parse --is-bare-repository)" = false && ` +
      `test -d .git && test "$(git rev-parse --git-common-dir)" = .git && ` +
      `test ! -s .git/objects/info/alternates`,
    );
    if (gitCheck.exitCode !== 0) {
      results.push({
        step: 'workdir',
        ok: false,
        message: `${absRepoPath} exists but is not an independent ordinary Git clone root — move it aside before retrying`,
      });
      return;
    }
    results.push({
      step: 'workdir',
      ok: true,
      message: `${absRepoPath} is an independent ordinary Git clone root`,
    });
  } else {
    results.push({
      step: 'workdir',
      ok: true,
      message: `${absRepoPath} does not yet exist; will be created by ${gh ? 'gh repo clone' : 'git clone'}`,
    });
  }

  if ('skip' in lsRemote) return;
  const lsRemoteOverride = lsRemote.urls?.[0];
  if (!gh) {
    const url = lsRemoteOverride ?? repo;
    const ls = await probeNetwork(runner, `${GIT_NET_ENV} git ls-remote ${shellQuote(url)} HEAD`);
    results.push({
      step: 'git',
      ok: ls.exitCode === 0,
      message: ls.exitCode === 0
        ? 'git ls-remote OK'
        : `git ls-remote ${redactGitCredentials(url)} failed — check the git credentials (HTTPS credential helper or SSH key) for this host`,
    });
    return;
  }

  if (lsRemoteOverride === undefined) return;
  const lsRemoteUrl = lsRemoteOverride;
  const protocol = lsRemoteUrl.startsWith('git@') || lsRemoteUrl.startsWith('ssh://') ? 'ssh' : 'https';
  const ls = await probeNetwork(runner, `${GIT_NET_ENV} git ls-remote ${shellQuote(lsRemoteUrl)} HEAD`);
  results.push({
    step: 'git',
    ok: ls.exitCode === 0,
    message: ls.exitCode === 0
      ? `git ls-remote (${protocol}) OK`
      : protocol === 'https'
        ? `git ls-remote ${lsRemoteUrl} failed — run "gh auth setup-git" to register the credential helper`
        : `git ls-remote ${lsRemoteUrl} failed — check ~/.ssh config; try "ssh -T git@github.com"`,
  });
}
