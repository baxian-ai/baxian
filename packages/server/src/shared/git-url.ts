const GITHUB_HTTPS_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/;
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

export function isGitHubRepo(repo: string): boolean {
  return normalizeRepoUrl(repo) !== null;
}

export function repoIdentityKey(repo: string): string {
  const t = repo.trim();
  const slug = normalizeRepoUrl(t);
  return slug === null ? t : `github.com/${slug.toLowerCase()}`;
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
