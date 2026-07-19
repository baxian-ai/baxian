import { describe, it, expect } from 'vitest';
import { parseDriverSpec } from '../../src/platform/driver-spec.js';

const MINIMAL = {
  ops: {
    listPrs: {
      argv: ['{binary}', 'api', 'projects/{repoPathEncoded}/merge_requests?page={page}'],
      parse: 'json-paged',
      map: {
        prNumber: 'iid', prUrl: 'web_url', branch: 'source_branch', headSha: 'sha',
        state: 'state', draft: 'draft', mergedAt: 'merged_at', updatedAt: 'updated_at',
        sourceProjectId: { sources: ['source_project_id'], optional: true },
        targetProjectId: 'target_project_id', targetBranch: 'target_branch',
      },
    },
    prView: {
      argv: ['{binary}', 'api', 'projects/{repoPathEncoded}/merge_requests/{prNumber}'],
      env: { GITLAB_HOST: '{scheme}://{hostname}' },
      parse: 'json',
      map: {
        headSha: 'sha', state: 'state', prUrl: 'web_url', branch: 'source_branch',
        draft: 'draft', mergedAt: 'merged_at',
        sourceProjectId: { sources: ['source_project_id'], optional: true },
        targetProjectId: 'target_project_id', targetBranch: 'target_branch',
      },
    },
    projectView: {
      argv: ['{binary}', 'api', 'projects/{repoPathEncoded}'],
      parse: 'json',
      map: { defaultBranch: 'default_branch' },
    },
    listComments: {
      argv: ['{binary}', 'api', 'projects/{repoPathEncoded}/merge_requests/{prNumber}/notes?page={page}'],
      parse: 'json-paged',
      map: { id: 'id', body: 'body', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    merge: {
      argv: ['{binary}', 'api', '-X', 'PUT', 'projects/{repoPathEncoded}/merge_requests/{prNumber}/merge', '-f', 'sha={expectedHeadSha}'],
    },
    close: {
      argv: ['{binary}', 'api', '-X', 'PUT', 'projects/{repoPathEncoded}/merge_requests/{prNumber}', '-f', 'state_event=close'],
    },
    deleteBranch: {
      argv: ['{binary}', 'api', '-X', 'DELETE', 'projects/{repoPathEncoded}/repository/branches/{branchEncoded}'],
      treatAsSuccess: ['REF_NOT_FOUND'],
    },
  },
  preflight: [{ argv: ['{binary}', '--version'], fixMessage: '安装 ≥ {minToolVersion}' }],
  errorClasses: [
    { class: 'RATE_LIMIT', regex: ['429 Too Many Requests'] },
    { class: 'ACCESS_DENIED', regex: ['401 Unauthorized'] },
    { class: 'NOT_FOUND', regex: ['404 Not Found'] },
    { class: 'MERGE_BLOCKED', regex: ['405 Method Not Allowed'] },
    { class: 'REF_NOT_FOUND', regex: ['404 Branch Not Found'] },
  ],
};

type LooseSpec = {
  ops: Record<string, Record<string, unknown>>;
  preflight: Array<Record<string, unknown> | null>;
  errorClasses: Array<Record<string, unknown> | null>;
};

const j = (o: unknown) => JSON.stringify(o);
const clone = (o: unknown): LooseSpec => JSON.parse(JSON.stringify(o));
const errMsgs = (o: unknown): string[] => {
  const r = parseDriverSpec(j(o), '/p/glab');
  return 'errors' in r ? r.errors.map(e => e.message) : [];
};

describe('parseDriverSpec', () => {
  it('accepts minimal valid spec', () => {
    const r = parseDriverSpec(j(MINIMAL), '/p/glab');
    expect('spec' in r).toBe(true);
  });

  it('unknown placeholder in argv is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.argv = ['{binary}', '{nope}'];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('{page} only allowed on json-paged ops', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.argv = ['{binary}', 'x?page={page}'];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
    const ok = clone(MINIMAL);
    ok.ops.listExtras = { argv: ['{binary}', 'x?page={page}'], parse: 'json-paged' };
    expect('spec' in parseDriverSpec(j(ok), '/p/glab')).toBe(true);
  });

  it('{minToolVersion} only allowed in preflight fixMessage', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.argv = ['{binary}', '{minToolVersion}'];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
    expect('spec' in parseDriverSpec(j(MINIMAL), '/p/glab')).toBe(true);
  });

  it('map target outside closed set is a load error', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).bogus = 'x';
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('map value object form requires non-empty sources', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).draft = { sources: [] };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('env values also honor placeholder whitelist', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = { GITLAB_HOST: '{wat}' };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops value null does not throw', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView = null as unknown as Record<string, unknown>;
    const result = parseDriverSpec(j(bad), '/p/glab');
    expect('errors' in result).toBe(true);
  });

  it('ops as an array is a load error, not silently empty ops', () => {
    const bad = clone(MINIMAL);
    bad.ops = [] as unknown as Record<string, Record<string, unknown>>;
    const result = parseDriverSpec(j(bad), '/p/glab');
    expect('errors' in result).toBe(true);
  });

  it('preflight array with null element does not throw', () => {
    const bad = clone(MINIMAL);
    bad.preflight[0] = null;
    const result = parseDriverSpec(j(bad), '/p/glab');
    expect('errors' in result).toBe(true);
  });

  it('errorClasses array with null element does not throw', () => {
    const bad = clone(MINIMAL);
    bad.errorClasses[0] = null;
    const result = parseDriverSpec(j(bad), '/p/glab');
    expect('errors' in result).toBe(true);
  });

  it('map value null does not throw', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).headSha = null;
    const result = parseDriverSpec(j(bad), '/p/glab');
    expect('errors' in result).toBe(true);
  });

  it('map value non-string/non-object does not throw', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).state = 123;
    const result = parseDriverSpec(j(bad), '/p/glab');
    expect('errors' in result).toBe(true);
  });

  it('ops.env non-string value does not throw', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = { GITLAB_HOST: 123 };
    const result = parseDriverSpec(j(bad), '/p/glab');
    expect('errors' in result).toBe(true);
  });

  it('preflight argv non-string element does not throw', () => {
    const bad = clone(MINIMAL);
    bad.preflight[0]!.argv = ['{binary}', '--version', 123];
    const result = parseDriverSpec(j(bad), '/p/glab');
    expect('errors' in result).toBe(true);
  });

  it('preflight env non-string value does not throw', () => {
    const bad = clone(MINIMAL);
    bad.preflight[0]!.env = { VAR: 456 };
    const result = parseDriverSpec(j(bad), '/p/glab');
    expect('errors' in result).toBe(true);
  });

  it('top-level null JSON does not throw', () => {
    const result = parseDriverSpec('null', '/p');
    expect('errors' in result).toBe(true);
  });

  it('errorClasses regex non-string element does not throw', () => {
    const bad = clone(MINIMAL);
    bad.errorClasses[0]!.regex = [123];
    const result = parseDriverSpec(j(bad), '/p/glab');
    expect('errors' in result).toBe(true);
  });

  it('ops.env key with invalid shape (contains =) is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = { 'KEY=VALUE': 'val' };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops.env key with invalid shape (contains space) is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = { 'KEY NAME': 'val' };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops.env key with invalid shape (contains semicolon) is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = { 'KEY;NAME': 'val' };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops.env key valid shapes are accepted', () => {
    const ok = clone(MINIMAL);
    ok.ops.prView.env = { VAR: 'val', VAR_NAME: 'val', _VAR: 'val', VAR123: 'val' };
    expect('spec' in parseDriverSpec(j(ok), '/p/glab')).toBe(true);
  });

  it('preflight.env key with invalid shape is a load error', () => {
    const bad = clone(MINIMAL);
    bad.preflight[0]!.env = { 'X=1': 'val' };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops.env key starting with digit is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = { '1VAR': 'val' };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('malformed placeholder token {prNumber1} in argv is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.argv = ['{binary}', 'x/{prNumber1}'];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('malformed placeholder token {repoPathEncoded_} in env is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = { GITLAB_HOST: '{repoPathEncoded_}' };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops.env as a number is a load error, not silently empty env', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = 123;
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops.env as null is a load error, not silently empty env', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = null;
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops.env as an array is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = [];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('preflight.env as a number is a load error, not silently empty env', () => {
    const bad = clone(MINIMAL);
    bad.preflight[0]!.env = 123;
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops argv[0] not literal {binary} (bare tool name) is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.argv = ['glab', 'api', 'projects/{repoPathEncoded}/merge_requests/{prNumber}'];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('preflight argv[0] not literal {binary} is a load error', () => {
    const bad = clone(MINIMAL);
    bad.preflight[0]!.argv = ['glab', '--version'];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops.flatten non-string is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.flatten = 123;
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops.map as null is a load error, not silently empty map', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.map = null;
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops.map as an array is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.map = [];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('ops.map as a scalar is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.map = 123;
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('preflight rejects task-context placeholders not available at preflight time', () => {
    for (const name of ['prNumber', 'expectedHeadSha', 'branchEncoded', 'page']) {
      const bad = clone(MINIMAL);
      bad.preflight[0]!.argv = ['{binary}', `x/{${name}}`];
      expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
    }
  });

  it('preflight env value with a task-context placeholder is a load error', () => {
    const bad = clone(MINIMAL);
    bad.preflight[0]!.env = { X: '{prNumber}' };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('preflight still allows host/repo placeholders (no task context needed)', () => {
    const ok = clone(MINIMAL);
    ok.preflight[0]!.argv = [
      '{binary}', '{scheme}', '{hostname}', '{host}', '{hostUrl}', '{repoPath}', '{repoPathEncoded}',
    ];
    expect('spec' in parseDriverSpec(j(ok), '/p/glab')).toBe(true);
  });

  it('treatAsSuccess non-array is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.treatAsSuccess = 'ACCESS_DENIED';
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('treatAsSuccess array containing a non-string element is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.treatAsSuccess = ['ACCESS_DENIED', 123];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('treatAsSuccess referencing a misspelled error class is a load error', () => {
    const bad = clone(MINIMAL);
    bad.errorClasses.push({ class: 'BRANCH_NOT_FOUND', regex: ['404 Branch Not Found'] });
    bad.ops.prView.treatAsSuccess = ['BRANCH_NOTFOUND'];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('treatAsSuccess referencing a declared error class is accepted', () => {
    const ok = clone(MINIMAL);
    ok.errorClasses.push({ class: 'ALREADY_CLOSED', regex: ['405 Already Closed'] });
    ok.ops.close.treatAsSuccess = ['ALREADY_CLOSED'];
    expect('spec' in parseDriverSpec(j(ok), '/p/glab')).toBe(true);
  });

  it('rejects treatAsSuccess on authoritative reads', () => {
    const onRead = clone(MINIMAL);
    onRead.ops.prView.treatAsSuccess = ['NOT_FOUND'];
    expect(errMsgs(onRead).join('\n')).toMatch(/ops\.prView\.treatAsSuccess is only allowed on merge\/close\/deleteBranch/);

    const onSource = clone(MINIMAL);
    onSource.ops.listComments.treatAsSuccess = ['NOT_FOUND'];
    expect(errMsgs(onSource).join('\n')).toMatch(/ops\.listComments\.treatAsSuccess is only allowed on/);
  });

  it('rejects op-level optional on lifecycle-required ops and comment sources', () => {
    const onRequired = clone(MINIMAL);
    onRequired.ops.prView.optional = true;
    expect(errMsgs(onRequired).join('\n')).toMatch(/ops\.prView\.optional must not be true/);

    const onSource = clone(MINIMAL);
    onSource.ops.listComments.optional = true;
    expect(errMsgs(onSource).join('\n')).toMatch(/ops\.listComments\.optional is not allowed on a comment source/);
  });

  it('pins parse by op kind: single-resource reads need json, writes must not be json-paged', () => {
    const noParse = clone(MINIMAL);
    delete noParse.ops.prView.parse;
    expect(errMsgs(noParse).join('\n')).toMatch(/ops\.prView\.parse must be 'json'/);

    const pagedProject = clone(MINIMAL);
    pagedProject.ops.projectView.parse = 'json-paged';
    pagedProject.ops.projectView.argv = ['{binary}', 'x?page={page}'];
    expect(errMsgs(pagedProject).join('\n')).toMatch(/ops\.projectView\.parse must be 'json'/);

    const pagedMerge = clone(MINIMAL);
    pagedMerge.ops.merge.parse = 'json-paged';
    pagedMerge.ops.merge.argv = [...(pagedMerge.ops.merge.argv as string[]), 'page={page}'];
    expect(errMsgs(pagedMerge).join('\n')).toMatch(/ops\.merge\.parse must not be 'json-paged'/);
  });

  it('requires lifecycle ops to consume their scope and atomicity placeholders', () => {
    const mergeNoSha = clone(MINIMAL);
    mergeNoSha.ops.merge.argv = ['{binary}', 'api', '-X', 'PUT', 'projects/{repoPathEncoded}/merge_requests/{prNumber}/merge'];
    expect(errMsgs(mergeNoSha).join('\n')).toMatch(/ops\.merge must consume \{expectedHeadSha\}/);

    const closeFixed = clone(MINIMAL);
    closeFixed.ops.close.argv = ['{binary}', 'api', '-X', 'PUT', 'projects/{repoPathEncoded}/merge_requests/999', '-f', 'state_event=close'];
    expect(errMsgs(closeFixed).join('\n')).toMatch(/ops\.close must consume \{prNumber\}/);

    const branchFixed = clone(MINIMAL);
    branchFixed.ops.deleteBranch.argv = ['{binary}', 'api', '-X', 'DELETE', 'projects/{repoPathEncoded}/repository/branches/fixed'];
    expect(errMsgs(branchFixed).join('\n')).toMatch(/ops\.deleteBranch must consume \{branch\} or \{branchEncoded\}/);

    const sourceNoPr = clone(MINIMAL);
    sourceNoPr.ops.listComments.argv = ['{binary}', 'api', 'projects/{repoPathEncoded}/notes?page={page}'];
    expect(errMsgs(sourceNoPr).join('\n')).toMatch(/ops\.listComments must consume \{prNumber\}/);
  });

  it('rejects optional body everywhere and all-optional timestamps outside reviews-class sources', () => {
    const optionalBody = clone(MINIMAL);
    (optionalBody.ops.listComments.map as Record<string, unknown>).body = { sources: ['body'], optional: true };
    expect(errMsgs(optionalBody).join('\n')).toMatch(/map\.body must not be optional/);

    const optionalTimes = clone(MINIMAL);
    (optionalTimes.ops.listComments.map as Record<string, unknown>).createdAt = { sources: ['created_at'], optional: true };
    (optionalTimes.ops.listComments.map as Record<string, unknown>).updatedAt = { sources: ['updated_at'], optional: true };
    expect(errMsgs(optionalTimes).join('\n')).toMatch(/at least one non-optional createdAt\/updatedAt/);

    const reviewsClass = clone(MINIMAL);
    reviewsClass.ops.listComments.map = {
      id: 'id', body: 'body',
      createdAt: { sources: ['submitted_at'], optional: true },
      updatedAt: { sources: ['submitted_at'], optional: true },
      reviewState: { sources: ['state'], optional: true },
    };
    expect('spec' in parseDriverSpec(j(reviewsClass), '/p/glab')).toBe(true);

    const spoofed = clone(MINIMAL);
    spoofed.ops.listComments.map = {
      id: 'id', body: { sources: ['body'], optional: true },
      createdAt: { sources: ['created_at'], optional: true },
      updatedAt: { sources: ['updated_at'], optional: true },
      reviewState: { sources: ['whatever'], optional: true },
    };
    expect(errMsgs(spoofed).join('\n')).toMatch(/map\.body must not be optional/);
  });

  it('json-paged op missing {page} in argv is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.parse = 'json-paged';
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('map value object optional as a non-boolean string is a load error', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).draft = { sources: ['draft'], optional: 'true' };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('op-level optional as a non-boolean string is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.optional = 'true';
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('unbalanced opening brace in argv is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.argv = ['{binary}', 'projects/{repoPathEncoded/merge_requests'];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('double-braced placeholder {{name}} is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.argv = ['{binary}', 'x/{{repoPathEncoded}}'];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('unbalanced brace in env value is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = { GITLAB_HOST: '{scheme}://{hostname' };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('empty string map source is a load error', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).headSha = '';
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('blank sources element in map object form is a load error', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).draft = { sources: ['  '] };
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('multi-level [] source path is rejected at load time, not first mapResponse', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).headSha = 'a[].b[].sha';
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('single-level [] source path stays accepted', () => {
    const ok = clone(MINIMAL);
    (ok.ops.prView.map as Record<string, unknown>).headSha = 'commits[].sha';
    expect('spec' in parseDriverSpec(j(ok), '/p/glab')).toBe(true);
  });

  it('blank flatten path is a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.flatten = ' ';
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('empty error-class regex string is a load error', () => {
    const bad = clone(MINIMAL);
    bad.errorClasses[0]!.regex = [''];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('blank error-class regex string is a load error', () => {
    const bad = clone(MINIMAL);
    bad.errorClasses[0]!.regex = ['  '];
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('flatten with [] syntax is a load error (op-level flatten is a plain dot path)', () => {
    for (const flatten of ['notes[]', 'discussion.notes[]']) {
      const bad = clone(MINIMAL);
      bad.ops.prView.flatten = flatten;
      expect('errors' in parseDriverSpec(j(bad), '/p/glab'), flatten).toBe(true);
    }
  });

  it('flatten with an empty path segment is a load error', () => {
    for (const flatten of ['a..b', '.a', 'a.']) {
      const bad = clone(MINIMAL);
      bad.ops.prView.flatten = flatten;
      expect('errors' in parseDriverSpec(j(bad), '/p/glab'), flatten).toBe(true);
    }
  });

  it('flatten as a plain dot path stays accepted', () => {
    const ok = clone(MINIMAL);
    ok.ops.prView.flatten = 'discussion.notes';
    expect('spec' in parseDriverSpec(j(ok), '/p/glab')).toBe(true);
  });

  it('map source with [] not at segment end is a load error', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).headSha = 'reviewers[]foo.name';
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('map source with an empty array key ([].name) is a load error', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).headSha = '[].name';
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('map source with an empty path segment is a load error', () => {
    for (const src of ['a..b', '.a', 'a.']) {
      const bad = clone(MINIMAL);
      (bad.ops.prView.map as Record<string, unknown>).headSha = src;
      expect('errors' in parseDriverSpec(j(bad), '/p/glab'), src).toBe(true);
    }
  });

  it('map source with an indexed segment (a[0].b) is a load error', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).headSha = 'a[0].b';
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('trailing-[] source and _discussion. parent reference (with flatten) stay accepted', () => {
    const ok = clone(MINIMAL);
    ok.ops.prView.flatten = 'notes';
    (ok.ops.prView.map as Record<string, unknown>).headSha = 'reviewers[].username';
    (ok.ops.prView.map as Record<string, unknown>).state = '_discussion.id';
    expect('spec' in parseDriverSpec(j(ok), '/p/glab')).toBe(true);
  });

  it('source segment with surrounding whitespace is a load error', () => {
    for (const src of [' sha', 'sha ', 'a. .b', 'a .b']) {
      const bad = clone(MINIMAL);
      (bad.ops.prView.map as Record<string, unknown>).headSha = src;
      expect('errors' in parseDriverSpec(j(bad), '/p/glab'), src).toBe(true);
    }
  });

  it('flatten segment with surrounding whitespace is a load error', () => {
    for (const flatten of [' notes', 'notes ', 'a. .b']) {
      const bad = clone(MINIMAL);
      bad.ops.prView.flatten = flatten;
      expect('errors' in parseDriverSpec(j(bad), '/p/glab'), flatten).toBe(true);
    }
  });

  it('bare "_discussion" source is a load error (including the "_discussion[]" bracket variant)', () => {
    for (const src of ['_discussion', '_discussion[].id']) {
      const bad = clone(MINIMAL);
      (bad.ops.prView.map as Record<string, unknown>).headSha = src;
      expect('errors' in parseDriverSpec(j(bad), '/p/glab'), src).toBe(true);
    }
  });

  it('"_discussion." parent reference without op.flatten is a load error; with flatten it passes', () => {
    const bad = clone(MINIMAL);
    (bad.ops.prView.map as Record<string, unknown>).state = '_discussion.id';
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);

    const ok = clone(MINIMAL);
    ok.ops.prView.flatten = 'notes';
    (ok.ops.prView.map as Record<string, unknown>).state = '_discussion.id';
    expect('spec' in parseDriverSpec(j(ok), '/p/glab')).toBe(true);

    const badSources = clone(MINIMAL);
    (badSources.ops.prView.map as Record<string, unknown>).state = { sources: ['_discussion.id'] };
    expect('errors' in parseDriverSpec(j(badSources), '/p/glab')).toBe(true);
  });

  it('duplicate errorClasses class name is a load error', () => {
    const bad = clone(MINIMAL);
    bad.errorClasses.push({ class: 'ACCESS_DENIED', regex: ['403 Forbidden'] });
    expect('errors' in parseDriverSpec(j(bad), '/p/glab')).toBe(true);
  });

  it('match-all error-class regex (matches empty string) is a load error', () => {
    for (const rx of ['|', '.*', '(?:)', '^', '$', 'a|']) {
      const bad = clone(MINIMAL);
      bad.errorClasses[0]!.regex = [rx];
      expect('errors' in parseDriverSpec(j(bad), '/p/glab'), rx).toBe(true);
    }
    const ok = clone(MINIMAL);
    ok.errorClasses[0]!.regex = ['^404 Branch Not Found'];
    expect('spec' in parseDriverSpec(j(ok), '/p/glab')).toBe(true);
  });

  it('invisible format characters (zero-width space) in source/flatten segments are load errors', () => {
    const badSource = clone(MINIMAL);
    (badSource.ops.prView.map as Record<string, unknown>).headSha = 'sha\u200b';
    expect('errors' in parseDriverSpec(j(badSource), '/p/glab')).toBe(true);

    const badFlatten = clone(MINIMAL);
    badFlatten.ops.prView.flatten = 'notes\u200b';
    expect('errors' in parseDriverSpec(j(badFlatten), '/p/glab')).toBe(true);
  });

  it('a malformed argv does not suppress the op\'s other errors (single-pass aggregation)', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.argv = [];
    (bad.ops.prView.map as Record<string, unknown>).bogus = 'x';
    (bad.ops.prView.map as Record<string, unknown>).headSha = 'a[].b[].sha';
    const msgs = errMsgs(bad);
    expect(msgs.some(m => m.includes('argv must be a non-empty string array'))).toBe(true);
    expect(msgs.some(m => m.includes('closed target field set'))).toBe(true);
    expect(msgs.some(m => m.includes("more than one '[]'"))).toBe(true);
  });

  it('a non-array argv does not crash the {page} check for json-paged ops', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.argv = 123 as unknown as string[];
    bad.ops.prView.parse = 'json-paged';
    const msgs = errMsgs(bad);
    expect(msgs.some(m => m.includes('argv must be a non-empty string array'))).toBe(true);
  });

  it('each source/error morphology rule reports its own characteristic message', () => {
    const src = (s: string) => {
      const bad = clone(MINIMAL);
      (bad.ops.prView.map as Record<string, unknown>).headSha = s;
      return errMsgs(bad).join('\n');
    };
    expect(src('a[].b[].sha')).toMatch(/more than one '\[\]'/);
    expect(src('reviewers[]foo.name')).toMatch(/malformed segment/);
    expect(src(' sha')).toMatch(/malformed segment/);
    expect(src('sha' + '\u200b')).toMatch(/malformed segment/);
    expect(src('_discussion')).toMatch(/reserved parent reference/);

    const noFlatten = clone(MINIMAL);
    (noFlatten.ops.prView.map as Record<string, unknown>).state = '_discussion.id';
    expect(errMsgs(noFlatten).join('\n')).toMatch(/requires op\.flatten/);

    const dupClass = clone(MINIMAL);
    dupClass.errorClasses.push({ class: 'ACCESS_DENIED', regex: ['403 Forbidden'] });
    expect(errMsgs(dupClass).join('\n')).toMatch(/duplicates 'ACCESS_DENIED'/);

    const matchAll = clone(MINIMAL);
    matchAll.errorClasses[0]!.regex = ['.*'];
    expect(errMsgs(matchAll).join('\n')).toMatch(/matches the empty string/);

    const unbalanced = clone(MINIMAL);
    unbalanced.ops.prView.argv = ['{binary}', 'x/{repoPathEncoded'];
    expect(errMsgs(unbalanced).join('\n')).toMatch(/unbalanced/);
  });

  it('env template values with control characters are a load error', () => {
    const bad = clone(MINIMAL);
    bad.ops.prView.env = { GITLAB_HOST: '{scheme}://{hostname}\nINJECTED=1' };
    expect(errMsgs(bad).join('\n')).toMatch(/control character/);
  });

  it('control characters inside source/flatten path segments are a load error', () => {
    const src = clone(MINIMAL);
    (src.ops.prView.map as Record<string, unknown>).headSha = 'head\nsha';
    expect(errMsgs(src).join('\n')).toMatch(/malformed segment/);

    const flat = clone(MINIMAL);
    flat.ops.prView.flatten = 'notes\nx';
    expect(errMsgs(flat).join('\n')).toMatch(/dot path of non-empty segments/);
  });

  it('a full-shape synthetic spec exercising every feature together parses without errors', () => {
    const fullShape = clone(MINIMAL);
    fullShape.ops.listPrs = {
      ...fullShape.ops.listPrs,
      env: { FORGE_HOST: '{hostname}' },
      map: {
        ...(fullShape.ops.listPrs.map as Record<string, unknown>),
        state: { sources: ['state'], values: { opened: 'open' } },
      },
    };
    fullShape.ops.listComments = {
      argv: ['{binary}', 'api', 'projects/{repoPathEncoded}/merge_requests/{prNumber}/discussions?page={page}'],
      parse: 'json-paged',
      flatten: 'notes',
      map: {
        id: 'id', body: 'body', discussionId: '_discussion.id',
        createdAt: 'created_at', updatedAt: { sources: ['updated_at'], optional: true },
      },
    };
    fullShape.ops.deleteBranch = {
      argv: ['{binary}', 'api', '-X', 'DELETE', 'repos/{repoPath}/git/refs/heads/{branch}'],
      treatAsSuccess: ['REF_NOT_FOUND'],
    };
    fullShape.preflight.push(
      { argv: ['{binary}', 'auth', 'status'], env: { FORGE_HOST: '{hostname}' }, fixMessage: '在 {host} 登录' },
    );
    const result = parseDriverSpec(j(fullShape), '/p/forge');
    if ('errors' in result) {
      throw new Error(`expected no errors, got:\n${result.errors.map(e => e.message).join('\n')}`);
    }
    expect('spec' in result).toBe(true);
  });
});

describe('parseDriverSpec: listComments multi-source', () => {
  const withComments = (listComments: unknown) => {
    const spec = clone(MINIMAL) as unknown as { ops: Record<string, unknown> };
    spec.ops.listComments = listComments;
    return spec;
  };
  const SOURCE = {
    argv: ['{binary}', 'api', 'repos/{repoPath}/issues/{prNumber}/comments?page={page}'],
    parse: 'json-paged',
    map: { id: 'id', body: 'body', createdAt: 'created_at' },
  };

  it('single object form normalizes to one source with implicit key "default"', () => {
    const r = parseDriverSpec(j(withComments(SOURCE)), '/p/x');
    if ('errors' in r) throw new Error(r.errors.map(e => e.message).join('\n'));
    expect(r.spec.commentSources).toHaveLength(1);
    expect(r.spec.commentSources[0]!.key).toBe('default');
    expect(r.spec.commentSources[0]!.map).toEqual(SOURCE.map);
    expect('listComments' in r.spec.ops).toBe(false);
  });

  it('single object form keeps an explicit key', () => {
    const r = parseDriverSpec(j(withComments({ ...SOURCE, key: 'notes' })), '/p/x');
    if ('errors' in r) throw new Error(r.errors.map(e => e.message).join('\n'));
    expect(r.spec.commentSources[0]!.key).toBe('notes');
  });

  it('array form preserves declaration order and keys', () => {
    const r = parseDriverSpec(j(withComments([
      { ...SOURCE, key: 'issue-comments' },
      { ...SOURCE, key: 'reviews' },
    ])), '/p/x');
    if ('errors' in r) throw new Error(r.errors.map(e => e.message).join('\n'));
    expect(r.spec.commentSources.map(s => s.key)).toEqual(['issue-comments', 'reviews']);
  });

  it('array form requires a key on every source', () => {
    expect(errMsgs(withComments([SOURCE])).join('\n'))
      .toMatch(/ops\.listComments\[0\]\.key must match/);
  });

  it('rejects malformed keys', () => {
    for (const key of ['Issue', '1a', 'a_b', '']) {
      expect(errMsgs(withComments([{ ...SOURCE, key }])).join('\n'))
        .toMatch(/ops\.listComments\[0\]\.key must match/);
    }
  });

  it('rejects duplicate keys across sources', () => {
    expect(errMsgs(withComments([{ ...SOURCE, key: 'a' }, { ...SOURCE, key: 'a' }])).join('\n'))
      .toMatch(/ops\.listComments\[1\]\.key duplicates 'a'/);
  });

  it('validates each array source with an indexed context', () => {
    const bad = withComments([{ ...SOURCE, key: 'a', argv: ['{binary}', '{nope}?page={page}'] }]);
    expect(errMsgs(bad).join('\n')).toMatch(/ops\.listComments\[0\]\.argv: unknown placeholder \{nope\}/);
  });

  it('rejects a non-object array element', () => {
    expect(errMsgs(withComments([null])).join('\n')).toMatch(/ops\.listComments\[0\] must be an object/);
  });

  it('normalized ops never contain listComments alongside commentSources', () => {
    const r = parseDriverSpec(j(MINIMAL), '/p/x');
    if ('errors' in r) throw new Error('unexpected errors');
    expect('listComments' in r.spec.ops).toBe(false);
    expect(r.spec.commentSources.map(s => s.key)).toEqual(['default']);
  });
});

describe('parseDriverSpec: visibilityLagSeconds', () => {
  it('defaults to 5 when omitted', () => {
    const r = parseDriverSpec(j(MINIMAL), '/p/x');
    if ('errors' in r) throw new Error('unexpected errors');
    expect(r.spec.visibilityLagSeconds).toBe(5);
  });

  it('accepts a positive finite number', () => {
    const spec = { ...clone(MINIMAL), visibilityLagSeconds: 12.5 } as Record<string, unknown>;
    const r = parseDriverSpec(j(spec), '/p/x');
    if ('errors' in r) throw new Error(r.errors.map(e => e.message).join('\n'));
    expect(r.spec.visibilityLagSeconds).toBe(12.5);
  });

  it('rejects zero, negatives, and non-numbers', () => {
    for (const bad of [0, -1, '5', null, true]) {
      const spec = { ...clone(MINIMAL), visibilityLagSeconds: bad } as Record<string, unknown>;
      expect(errMsgs(spec).join('\n')).toMatch(/visibilityLagSeconds must be a positive number/);
    }
  });
});

describe('parseDriverSpec: values translation table', () => {
  const withStateValues = (values: unknown) => {
    const spec = clone(MINIMAL);
    (spec.ops.prView.map as Record<string, unknown>).state = { sources: ['state'], values };
    return spec;
  };

  it('accepts a string-to-string record', () => {
    expect('spec' in parseDriverSpec(j(withStateValues({ opened: 'open', merged: 'closed' })), '/p/x')).toBe(true);
  });

  it('rejects non-record and non-string entries', () => {
    expect(errMsgs(withStateValues(['opened'])).join('\n'))
      .toMatch(/ops\.prView\.map\.state\.values must be a string-to-string record/);
    expect(errMsgs(withStateValues({ opened: 1 })).join('\n'))
      .toMatch(/ops\.prView\.map\.state\.values must be a string-to-string record/);
  });

  it('display and actor fields are in the closed target set', () => {
    const spec = clone(MINIMAL);
    spec.ops.prView.map = {
      ...(spec.ops.prView.map as Record<string, unknown>),
      reviewState: 'state', path: 'path', line: 'line', originalLine: 'original_line',
      commitSha: 'commit_id', authorId: 'user.id', prAuthor: 'user.login', prAuthorId: 'user.id',
      pushPermitted: 'permissions.push',
    };
    const r = parseDriverSpec(j(spec), '/p/x');
    if ('errors' in r) throw new Error(r.errors.map(e => e.message).join('\n'));
  });
});

describe('parseDriverSpec: {branch} placeholder', () => {
  it('is allowed in op argv and env', () => {
    const spec = clone(MINIMAL);
    spec.ops.deleteBranch = {
      argv: ['{binary}', 'api', '-X', 'DELETE', 'repos/{repoPath}/git/refs/heads/{branch}'],
      env: { REF: '{branch}' },
    };
    const r = parseDriverSpec(j(spec), '/p/x');
    if ('errors' in r) throw new Error(r.errors.map(e => e.message).join('\n'));
  });

  it('is not allowed in preflight (task context)', () => {
    const spec = clone(MINIMAL);
    spec.preflight = [{ argv: ['{binary}', 'check', '{branch}'], fixMessage: 'x' }];
    expect(errMsgs(spec).join('\n')).toMatch(/preflight\[0\]\.argv: unknown placeholder \{branch\}/);
  });
});

describe('parseDriverSpec: driverSchema 1 load-time contract', () => {
  it('rejects a spec missing a lifecycle-required op', () => {
    const spec = clone(MINIMAL);
    delete (spec.ops as Record<string, unknown>).prView;
    expect(errMsgs(spec).join('\n')).toMatch(/ops\.prView is required by driverSchema 1/);
  });

  it('rejects listPrs missing a lifecycle-required mapping declaration', () => {
    const spec = clone(MINIMAL);
    delete (spec.ops.listPrs.map as Record<string, unknown>).targetProjectId;
    expect(errMsgs(spec).join('\n'))
      .toMatch(/ops\.listPrs\.map\.targetProjectId must be declared \(lifecycle-required mapping\)/);
  });

  it('sourceProjectId may be optional-valued but must be declared', () => {
    const declared = clone(MINIMAL);
    expect('spec' in parseDriverSpec(j(declared), '/p/x')).toBe(true);

    const omitted = clone(MINIMAL);
    delete (omitted.ops.prView.map as Record<string, unknown>).sourceProjectId;
    expect(errMsgs(omitted).join('\n'))
      .toMatch(/ops\.prView\.map\.sourceProjectId must be declared \(lifecycle-required mapping\)/);
  });

  it('rejects a comment source omitting both timestamp mappings', () => {
    const spec = clone(MINIMAL);
    const src = spec.ops.listComments as { map: Record<string, unknown> };
    delete src.map.createdAt;
    delete src.map.updatedAt;
    expect(errMsgs(spec).join('\n'))
      .toMatch(/ops\.listComments must declare at least one of createdAt\/updatedAt/);
  });

  it('rejects a comment source missing id or body, with indexed context in array form', () => {
    const spec = clone(MINIMAL);
    spec.ops.listComments = [
      { ...(spec.ops.listComments as Record<string, unknown>), key: 'notes', map: { body: 'body', createdAt: 'created_at' } },
    ];
    expect(errMsgs(spec).join('\n'))
      .toMatch(/ops\.listComments\[0\]\.map\.id must be declared \(lifecycle-required mapping\)/);
  });

  it('rejects missing reserved error classes and does not accept near-synonym substitutes', () => {
    const noRateLimit = clone(MINIMAL);
    noRateLimit.errorClasses = (noRateLimit.errorClasses as Array<{ class: string }>).filter(c => c!.class !== 'RATE_LIMIT');
    expect(errMsgs(noRateLimit).join('\n')).toMatch(/errorClasses must declare 'RATE_LIMIT' \(reserved, required by core\)/);

    const forbiddenInstead = clone(MINIMAL);
    forbiddenInstead.errorClasses = (forbiddenInstead.errorClasses as Array<{ class: string; regex: string[] }>)
      .map(c => (c!.class === 'ACCESS_DENIED' ? { ...c!, class: 'FORBIDDEN' } : c));
    expect(errMsgs(forbiddenInstead).join('\n')).toMatch(/errorClasses must declare 'ACCESS_DENIED'/);

    const noMergeBlocked = clone(MINIMAL);
    noMergeBlocked.errorClasses = (noMergeBlocked.errorClasses as Array<{ class: string }>).filter(c => c!.class !== 'MERGE_BLOCKED');
    expect(errMsgs(noMergeBlocked).join('\n')).toMatch(/errorClasses must declare 'MERGE_BLOCKED' \(reserved, required by merge\)/);

    const noRefNotFound = clone(MINIMAL);
    noRefNotFound.errorClasses = (noRefNotFound.errorClasses as Array<{ class: string }>).filter(c => c!.class !== 'REF_NOT_FOUND');
    delete (noRefNotFound.ops.deleteBranch as Record<string, unknown>).treatAsSuccess;
    expect(errMsgs(noRefNotFound).join('\n')).toMatch(/errorClasses must declare 'REF_NOT_FOUND' \(reserved, required by deleteBranch\)/);
  });
});

describe('parseDriverSpec: empty listComments array', () => {
  it('rejects an empty source list', () => {
    const spec = clone(MINIMAL);
    spec.ops.listComments = [] as unknown as Record<string, unknown>;
    expect(errMsgs(spec).join('\n')).toMatch(/ops\.listComments must declare at least one source/);
  });
});

describe('parseDriverSpec: paged lifecycle ops', () => {
  it('requires json-paged parse on listPrs and every comment source', () => {
    const badList = clone(MINIMAL);
    badList.ops.listPrs = { ...badList.ops.listPrs, parse: 'json', argv: ['{binary}', 'api', 'x'] };
    expect(errMsgs(badList).join('\n')).toMatch(/ops\.listPrs\.parse must be 'json-paged'/);

    const badSource = clone(MINIMAL);
    badSource.ops.listComments = { ...(badSource.ops.listComments as Record<string, unknown>), parse: 'json', argv: ['{binary}', 'api', 'x'] };
    expect(errMsgs(badSource).join('\n')).toMatch(/ops\.listComments\.parse must be 'json-paged'/);
  });
});
