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
  /** Lowercased — DNS is case-insensitive; may include `:port` for https/ssh-url forms. */
  host: string;
  /** Case preserved — generic git paths can be case-sensitive; trailing `.git`/slashes stripped. */
  path: string;
}

// Optional `user[:secret]@` userinfo is stripped from all three forms: it is an access
// credential, not repo identity — keeping it would leak a token into the local clone dir /
// error text and split one repo into many hosts/origins as the token rotates.
const REMOTE_SSH_URL_RE = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/;
const REMOTE_HTTPS_RE = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/;
const REMOTE_SSH_SCP_RE = /^[^@/\s]+@([^:/\s]+):(.+?)(?:\.git)?\/?$/;
const BARE_SLUG_RE = /^[^/\s:@]+\/[^\s]+$/;

// Parses any-host git URL (https / ssh-url / scp) into host + path. Returns null
// for bare "owner/repo" and unparseable strings — callers treat null-with-bare-slug
// as the legacy github.com form (see isGitHubRepo).
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

// A host (with optional :port) made only of DNS-safe labels — no empty / "." / ".." labels,
// no slashes or shell/filesystem metacharacters. Guards the host BEFORE it becomes a directory
// component (repos-ext/<host>/…) or a config identity: parseGitRemote captures the host as
// `[^/]+`, so without this a URL like `https://../x.git` would yield host `..` and traverse.
const HOST_LABEL_RE = /^[A-Za-z0-9_-]+$/;
export function isSafeGitHost(host: string): boolean {
  if (!host) return false;
  return host.split(/[.:]/).every(label => HOST_LABEL_RE.test(label));
}

// The single platform predicate: github.com (any URL form, with or without an explicit
// port) and legacy bare "owner/repo" are github; every other host is a generic git remote.
// Port-bearing github URLs are detected here (then rejected by the validator's owner/repo
// rule) rather than silently misrouted to server mode / skipped by the poller.
export function isGitHubRepo(repo: string): boolean {
  const parsed = parseGitRemote(repo);
  if (parsed) return parsed.host.split(':')[0] === 'github.com';
  return BARE_SLUG_RE.test(repo.trim());
}

// True if a URL embeds a credential that must not live in project.repo — it would leak through the
// config file, API config/project responses, and logs. http(s): ANY userinfo (a token is often the
// username). ssh://: userinfo containing ':' (a password/secret). Plain `ssh://git@host` and
// `git@host:path` SSH logins are exempt — the user is a login name, not a secret (auth is by key).
export function hasEmbeddedCredentials(repo: string): boolean {
  const url = repo.trim();
  if (/^https?:\/\/[^/@]*@/.test(url)) return true;
  const ssh = url.match(/^ssh:\/\/([^/@]*)@/);
  return ssh !== null && ssh[1].includes(':');
}

// Strip embedded `user[:secret]@` userinfo from any https/ssh URL in the text. Used before
// putting a repo URL (or git's own stderr, which echoes the URL) into errors / logs / events
// so a token in `https://oauth2:TOKEN@host/…` is never persisted.
export function redactGitCredentials(text: string): string {
  return text.replace(/((?:https?|ssh):\/\/)[^/\s@]+@/gi, '$1');
}
