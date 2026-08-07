export function hasEmbeddedCredentials(repo: string): boolean {
  const url = repo.trim();
  if (/^https?:\/\/[^/@]*@/.test(url)) return true;
  const ssh = url.match(/^ssh:\/\/([^/@]*)@/);
  return ssh !== null && ssh[1].includes(':');
}

export function redactGitCredentials(text: string): string {
  return text.replace(/((?:https?|ssh):\/\/)[^/\s@]+@/gi, '$1');
}
