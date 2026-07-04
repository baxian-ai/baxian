import type { CommandRunner } from './runner.js';
import { lastNonEmptyLine } from './preflight.js';
import { TmuxManager } from './tmux.js';

export interface TmuxInstallResult {
  ok: boolean;
  method?: string;
  version?: string;
  message: string;
}

const PROBE_TIMEOUT_MS = 5000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

interface LinuxPackageManager {
  name: string;
  install: string;
  refresh?: string;
  manual: string;
}

const LINUX_PACKAGE_MANAGERS: LinuxPackageManager[] = [
  {
    name: 'apt-get',
    install: 'env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux',
    refresh: 'apt-get update',
    manual: 'sudo apt-get install -y tmux',
  },
  { name: 'dnf', install: 'dnf install -y tmux', manual: 'sudo dnf install -y tmux' },
  { name: 'yum', install: 'yum install -y tmux', manual: 'sudo yum install -y tmux' },
  { name: 'pacman', install: 'pacman -S --noconfirm tmux', manual: 'sudo pacman -S tmux' },
  {
    name: 'zypper',
    install: 'zypper --non-interactive install tmux',
    manual: 'sudo zypper install tmux',
  },
  { name: 'apk', install: 'apk add tmux', manual: 'sudo apk add tmux' },
];

const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

export async function installTmux(runner: CommandRunner): Promise<TmuxInstallResult> {
  try {
    return await install(runner);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `tmux install failed: ${msg}` };
  }
}

async function install(runner: CommandRunner): Promise<TmuxInstallResult> {
  const existing = await binaryPath(runner, 'tmux');
  if (existing) {
    return { ok: true, method: 'already-installed', message: `tmux already installed at ${existing}` };
  }

  const uname = await runner.exec('uname -s', { timeout: PROBE_TIMEOUT_MS });
  const platform = uname.stdout.trim();
  if (platform === 'Darwin') return installOnMacOS(runner);
  if (platform === 'Linux') return installOnLinux(runner);
  return {
    ok: false,
    message: `unsupported platform "${platform || 'unknown'}" — install tmux manually`,
  };
}

async function installOnMacOS(runner: CommandRunner): Promise<TmuxInstallResult> {
  const brew = await resolveBrew(runner);
  if (!brew) {
    return {
      ok: false,
      message:
        'Homebrew not found — install it from https://brew.sh first, then run "brew install tmux"',
    };
  }
  const result = await runner.exec(
    `HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 ${brew} install tmux`,
    { timeout: INSTALL_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      method: 'brew',
      message: `brew install tmux failed (exit ${result.exitCode}): ${outputTail(result.stderr || result.stdout)}`,
    };
  }
  return verifyInstalled(runner, 'brew');
}

async function resolveBrew(runner: CommandRunner): Promise<string | undefined> {
  const onPath = await binaryPath(runner, 'brew');
  if (onPath) return onPath;
  for (const candidate of BREW_CANDIDATES) {
    const probe = await runner.exec(`test -x ${candidate}`, { timeout: PROBE_TIMEOUT_MS });
    if (probe.exitCode === 0) return candidate;
  }
  return undefined;
}

async function installOnLinux(runner: CommandRunner): Promise<TmuxInstallResult> {
  const pm = await detectLinuxPackageManager(runner);
  if (!pm) {
    const names = LINUX_PACKAGE_MANAGERS.map(p => p.name).join('/');
    return { ok: false, message: `no supported package manager found (${names}) — install tmux manually` };
  }
  const sudo = await sudoPrefix(runner);
  if (sudo === undefined) {
    return {
      ok: false,
      method: pm.name,
      message:
        `cannot install automatically: not root and passwordless sudo is unavailable — run "${pm.manual}" on the host`,
    };
  }
  let result = await runner.exec(`${sudo}${pm.install}`, { timeout: INSTALL_TIMEOUT_MS });
  if (result.exitCode !== 0 && pm.refresh) {
    await runner.exec(`${sudo}${pm.refresh}`, { timeout: INSTALL_TIMEOUT_MS });
    result = await runner.exec(`${sudo}${pm.install}`, { timeout: INSTALL_TIMEOUT_MS });
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      method: pm.name,
      message: `${pm.name} install failed (exit ${result.exitCode}): ${outputTail(result.stderr || result.stdout)}`,
    };
  }
  return verifyInstalled(runner, pm.name);
}

async function detectLinuxPackageManager(
  runner: CommandRunner,
): Promise<LinuxPackageManager | undefined> {
  for (const pm of LINUX_PACKAGE_MANAGERS) {
    const probe = await runner.exec(`command -v ${pm.name}`, { timeout: PROBE_TIMEOUT_MS });
    if (probe.exitCode === 0 && lastNonEmptyLine(probe.stdout)) return pm;
  }
  return undefined;
}

async function sudoPrefix(runner: CommandRunner): Promise<string | undefined> {
  const id = await runner.exec('id -u', { timeout: PROBE_TIMEOUT_MS });
  if (id.stdout.trim() === '0') return '';
  const sudo = await runner.exec('sudo -n true', { timeout: PROBE_TIMEOUT_MS });
  return sudo.exitCode === 0 ? 'sudo -n ' : undefined;
}

async function verifyInstalled(runner: CommandRunner, method: string): Promise<TmuxInstallResult> {
  const path = await binaryPath(runner, 'tmux');
  if (!path) {
    return {
      ok: false,
      method,
      message: `installed via ${method} but tmux is still not found on PATH`,
    };
  }
  try {
    const { major, minor } = await TmuxManager.probeTmuxVersion(runner);
    const version = `${major}.${minor}`;
    return { ok: true, method, version, message: `tmux ${version} installed via ${method}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, method, message: `installed via ${method} but verification failed: ${msg}` };
  }
}

async function binaryPath(runner: CommandRunner, binary: string): Promise<string | undefined> {
  // command -v over which: minimal Linux images may lack which, and every runner execs through a shell.
  const result = await runner.exec(`command -v ${binary}`, { timeout: PROBE_TIMEOUT_MS });
  const path = lastNonEmptyLine(result.stdout);
  return result.exitCode === 0 && path ? path : undefined;
}

function outputTail(s: string, limit = 400): string {
  const trimmed = s.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}
