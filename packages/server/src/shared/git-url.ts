const GITHUB_HTTPS_RE = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/;
const GITHUB_SSH_SCP_RE = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/;
const GITHUB_SSH_URL_RE = /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/;

export function normalizeRepoUrl(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return (
    trimmed.match(GITHUB_HTTPS_RE)?.[1]
    ?? trimmed.match(GITHUB_SSH_SCP_RE)?.[1]
    ?? trimmed.match(GITHUB_SSH_URL_RE)?.[1]
    ?? null
  );
}

export function repoSlug(repo: string): string {
  return normalizeRepoUrl(repo) ?? repo.trim();
}

export interface GitRemote {
  host: string;
  path: string;
}

const REMOTE_SSH_URL_RE = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/;
const REMOTE_HTTPS_RE = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/;
const REMOTE_SSH_SCP_RE = /^[^@/\s]+@([^:/\s]+):(.+?)(?:\.git)?\/?$/;
const BARE_SLUG_RE = /^[^/\s:@]+\/[^\s]+$/;

export function parseGitRemote(url: string): GitRemote | null {
  if (!url) return null;
  const t = url.trim();
  const m = t.match(REMOTE_SSH_URL_RE) ?? t.match(REMOTE_HTTPS_RE) ?? t.match(REMOTE_SSH_SCP_RE);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const path = m[2];
  if (!host || !path) return null;
  return { host, path };
}

const HOST_LABEL_RE = /^[A-Za-z0-9_-]+$/;
export function isSafeGitHost(host: string): boolean {
  if (!host) return false;
  return host.split(/[.:]/).every(label => HOST_LABEL_RE.test(label));
}

export function isGitHubRepo(repo: string): boolean {
  const parsed = parseGitRemote(repo);
  if (parsed) return parsed.host.split(':')[0] === 'github.com';
  return BARE_SLUG_RE.test(repo.trim());
}

export function hasEmbeddedCredentials(repo: string): boolean {
  const url = repo.trim();
  if (/^https?:\/\/[^/@]*@/.test(url)) return true;
  const ssh = url.match(/^ssh:\/\/([^/@]*)@/);
  return ssh !== null && ssh[1].includes(':');
}

export function redactGitCredentials(text: string): string {
  return text.replace(/((?:https?|ssh):\/\/)[^/\s@]+@/gi, '$1');
}
