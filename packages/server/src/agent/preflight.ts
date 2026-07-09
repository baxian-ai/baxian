import type { CommandRunner, RemoteShellMode } from './runner.js';
import { LocalRunner, buildSshOptions, ensureMuxDir, shellQuote, sshTarget, sshEnv } from './runner.js';
import { GH_EXEC_TIMEOUT_MS, GIT_NET_ENV, execNetwork } from './net-exec.js';
import type { AgentConfig, AgentRuntime, HostConfig } from '../shared/index.js';
import { isGitHubRepo, redactGitCredentials, repoSlug } from '../shared/index.js';
import { nonGitHubSubpath } from './repo-store.js';

export interface PreflightResult {
  step: string;
  ok: boolean;
  message: string;
}

const CLI_BINARY: Record<AgentRuntime, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  qodercli: 'qodercli',
};

const PREFLIGHT_PROBE_TIMEOUT_MS = 5000;

// Health checks must answer fast: a timeout is itself the diagnosis, so no retry,
// and a timeout rejection becomes a failed step instead of aborting the preflight.
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
    // command -v over which: it must match installTmux's verification, or a --fix
    // success on a which-less minimal host would still re-probe as FAIL.
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

  if (agent.mode === 'remote') {
    results.push(
      await probeBinary(
        runner,
        'openssl',
        'openssl',
        (path) => `openssl found at ${path}`,
        'Please install openssl on the agent host (used to decode skill/task files during injection)',
      ),
    );
  }

  const isAuto = !agent.workdir;
  if (isAuto) {
    await runAutoModePreflight(runner, repo, results);
  } else {
    await runManualModePreflight(runner, agent.workdir!, repo, results);
  }

  if (isGitHubRepo(repo)) {
    const slug = repoSlug(repo);
    const ghCheck = await runner.exec('gh auth status');
    results.push({
      step: 'gh',
      ok: ghCheck.exitCode === 0,
      message: ghCheck.exitCode === 0 ? 'GitHub CLI authenticated' : 'Run "gh auth login" or set GITHUB_TOKEN',
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

async function runManualModePreflight(
  runner: CommandRunner,
  workdir: string,
  repo: string,
  results: PreflightResult[],
): Promise<void> {
  const workdirCheck = await runner.exec(
    `cd ${shellQuote(workdir)} && git rev-parse --is-inside-work-tree`,
  );
  results.push({
    step: 'workdir',
    ok: workdirCheck.exitCode === 0 && workdirCheck.stdout.trim() === 'true',
    message: workdirCheck.exitCode === 0
      ? `${workdir} is a git workdir`
      : `${workdir} is not accessible or not a git repository`,
  });

  const lsRemoteUrl = isGitHubRepo(repo) ? `https://github.com/${repoSlug(repo)}.git` : repo;
  const gitCheck = await probeNetwork(runner, `${GIT_NET_ENV} git ls-remote ${shellQuote(lsRemoteUrl)} HEAD`);
  results.push({
    step: 'git',
    ok: gitCheck.exitCode === 0,
    message: gitCheck.exitCode === 0
      ? 'Git repository accessible'
      : 'Cannot access repository — check SSH key or HTTPS credentials',
  });
}

async function runAutoModePreflight(
  runner: CommandRunner,
  repo: string,
  results: PreflightResult[],
): Promise<void> {
  const gh = isGitHubRepo(repo);
  const relPath = gh ? `repos/${repoSlug(repo).toLowerCase()}` : nonGitHubSubpath(repo);
  const root = `~/.baxian/${relPath.split('/')[0]}`;
  const absRepoPath = `~/.baxian/${relPath}`;
  const mk = await runner.exec(`mkdir -p ${root} && test -w ${root}`);
  if (mk.exitCode !== 0) {
    results.push({
      step: 'workdir',
      ok: false,
      message: `Cannot create or write to ${root}: ${mk.stderr || mk.stdout}`,
    });
    return;
  }

  const dirCheck = await runner.exec(`test -d ${absRepoPath}`);
  if (dirCheck.exitCode === 0) {
    // Same probe as RepoStore: accepts both bare stores and working-tree clones
    // without git's upward discovery matching an ancestor repo.
    const gitCheck = await runner.exec(
      `git rev-parse --resolve-git-dir ${absRepoPath} || git rev-parse --resolve-git-dir ${absRepoPath}/.git`,
    );
    if (gitCheck.exitCode !== 0) {
      results.push({
        step: 'workdir',
        ok: false,
        message: `${absRepoPath} exists but is not a git repository — remove it manually before running`,
      });
      return;
    }
    results.push({
      step: 'workdir',
      ok: true,
      message: `${absRepoPath} is a git workdir`,
    });
  } else {
    results.push({
      step: 'workdir',
      ok: true,
      message: `${absRepoPath} does not yet exist; will be created by ${gh ? 'gh repo clone' : 'git clone'}`,
    });
  }

  if (!gh) {
    const ls = await probeNetwork(runner, `${GIT_NET_ENV} git ls-remote ${shellQuote(repo)} HEAD`);
    results.push({
      step: 'git',
      ok: ls.exitCode === 0,
      message: ls.exitCode === 0
        ? 'git ls-remote OK'
        : `git ls-remote ${redactGitCredentials(repo)} failed — check the git credentials (HTTPS credential helper or SSH key) for this host`,
    });
    return;
  }

  const slug = repoSlug(repo);
  const proto = await runner.exec('gh config get git_protocol');
  const protocol = proto.stdout.trim() || 'https';
  const lsRemoteUrl = protocol === 'ssh'
    ? `git@github.com:${slug}.git`
    : `https://github.com/${slug}.git`;
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
