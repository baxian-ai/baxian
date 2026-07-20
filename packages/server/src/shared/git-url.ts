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

export function isBareRepoSlug(repo: string): boolean {
  return BARE_SLUG_RE.test(repo.trim());
}

export function isGitHubRepo(repo: string): boolean {
  const parsed = parseGitRemote(repo);
  if (parsed) return parsed.host.split(':')[0] === 'github.com';
  return BARE_SLUG_RE.test(repo.trim());
}

export interface RepoUrlParts {
  scheme: 'http' | 'https';
  hostname: string;
  port: string;
  path: string;
}

// 非 github URL 的三段分解单点定义：身份键与 driver 渲染上下文各自投影同一分解结果，
// 归一化细节（.git/尾斜杠剥离、默认端口折叠）双写会各自漂移——cursor 身份与命令渲染
// 对同一 URL 的解读必须一致。先走 WHATWG URL 是为消默认端口别名（https:443 → port ''）；
// scp/ssh 缺省按 https 语义投影（凭据通道由 git 自身处理，此处只描述 API 面）。
export function parseRepoUrlParts(repo: string): RepoUrlParts | null {
  const t = repo.trim();
  try {
    const url = new URL(t);
    return {
      scheme: url.protocol === 'http:' ? 'http' : 'https',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, ''),
    };
  } catch {
    const remote = parseGitRemote(t);
    if (!remote) return null;
    const [hostname, port = ''] = remote.host.split(':');
    return { scheme: 'https', hostname, port, path: remote.path };
  }
}

// 归一化 repo 身份键的唯一定义（spec v2 §4）：M1 服务配置查重；M3 poller entry key / 状态文件 key 收敛到此，
// 取代 manager.projectRepoKey 与 poller 的 repoSlug 键（legacy 路径届时随 spec §13 一并退役）。
// github：owner/repo 大小写不敏感（平台契约），全形态（含裸 slug）折叠进 github.com 命名空间；
// 非 github：RFC 3986 仅 scheme/host 不敏感，路径大小写保留——自定义 forge 上 /Team/App 与 /team/app 可以是两个仓库。
export function repoIdentityKey(repo: string): string {
  const t = repo.trim();
  // repoSlug 的正则只剥小写 .git；先折叠大小写再剥后缀，否则 Repo.GIT 与 repo 归一成不同键绕过查重。
  if (isGitHubRepo(t)) return `github.com/${repoSlug(t).toLowerCase().replace(/\.git$/, '')}`;
  const parts = parseRepoUrlParts(t);
  if (parts === null) return t;
  const port = parts.port === '' ? '' : `:${parts.port}`;
  return parts.path === '' ? `${parts.hostname}${port}` : `${parts.hostname}${port}/${parts.path}`;
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
