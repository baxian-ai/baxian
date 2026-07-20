export const MANIFEST = (tool: string, name = tool) => JSON.stringify({
  name, version: '1.0.0', kind: 'git-driver', tool, minToolVersion: '1.0.0', driverSchema: 1,
});

export const DRIVER = JSON.stringify({
  ops: {
    listPrs: {
      argv: ['{binary}', 'api', 'repos/{repoPath}/pulls?page={page}'],
      parse: 'json-paged',
      map: {
        prNumber: 'number', prUrl: 'html_url', branch: 'head.ref', headSha: 'head.sha',
        state: 'state', draft: 'draft', mergedAt: 'merged_at', updatedAt: 'updated_at',
        sourceProjectId: { sources: ['head.repo.id'], optional: true },
        targetProjectId: 'base.repo.id', targetBranch: 'base.ref',
      },
    },
    prView: {
      argv: ['{binary}', 'api', 'repos/{repoPath}/pulls/{prNumber}'],
      parse: 'json',
      map: {
        prUrl: 'html_url', branch: 'head.ref', headSha: 'head.sha', state: 'state',
        draft: 'draft', mergedAt: 'merged_at',
        sourceProjectId: { sources: ['head.repo.id'], optional: true },
        targetProjectId: 'base.repo.id', targetBranch: 'base.ref',
      },
    },
    projectView: {
      argv: ['{binary}', 'api', 'repos/{repoPath}'],
      parse: 'json',
      map: { defaultBranch: 'default_branch' },
    },
    listComments: {
      argv: ['{binary}', 'api', 'repos/{repoPath}/issues/{prNumber}/comments?page={page}'],
      parse: 'json-paged',
      map: { id: 'id', body: 'body', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    merge: {
      argv: ['{binary}', 'api', '-X', 'PUT', 'repos/{repoPath}/pulls/{prNumber}/merge', '-f', 'sha={expectedHeadSha}'],
    },
    close: {
      argv: ['{binary}', 'api', '-X', 'PATCH', 'repos/{repoPath}/pulls/{prNumber}', '-f', 'state=closed'],
    },
    deleteBranch: {
      argv: ['{binary}', 'api', '-X', 'DELETE', 'repos/{repoPath}/git/refs/heads/{branch}'],
      treatAsSuccess: ['REF_NOT_FOUND'],
    },
  },
  preflight: [{ argv: ['{binary}', '--version'], fixMessage: 'install it', versionCheck: true }],
  errorClasses: [
    { class: 'RATE_LIMIT', regex: ['429'] },
    { class: 'ACCESS_DENIED', regex: ['401', '403'] },
    { class: 'NOT_FOUND', regex: ['404'] },
    { class: 'MERGE_BLOCKED', regex: ['405'] },
    { class: 'REF_NOT_FOUND', regex: ['Reference does not exist'] },
  ],
});
