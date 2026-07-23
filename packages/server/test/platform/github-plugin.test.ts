import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginRegistry, type LoadedPlugin } from '../../src/platform/plugin-registry.js';
import { renderCommand, renderFixMessage, type RenderContext } from '../../src/platform/command-renderer.js';
import { classifyCommentSource } from '../../src/platform/markers.js';

const BUILTIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../src/platform/plugins');
const SHA = 'a'.repeat(40);
const CTX: RenderContext = {
  scheme: 'https', hostname: 'github.com', host: 'github.com', repoPath: 'owner/repo',
  binary: 'gh', prNumber: 42, expectedHeadSha: SHA, remoteProjectId: 'R_repo123', branch: 'bx/task-1', page: 3,
};

let userRoot = '';
let plugin: LoadedPlugin;

beforeAll(async () => {
  userRoot = await mkdtemp(join(tmpdir(), 'bx-empty-user-'));
  const { registry, diagnostics } = await PluginRegistry.load({ builtin: BUILTIN_ROOT, user: userRoot });
  expect(diagnostics).toEqual([]);
  const resolved = registry.resolveTool('gh');
  if (!resolved) throw new Error('builtin github plugin failed to resolve tool gh');
  plugin = resolved;
});

afterAll(async () => {
  await rm(userRoot, { recursive: true, force: true });
});

describe('builtin github plugin: loading', () => {
  it('loads from the builtin root with zero diagnostics and the expected identity', () => {
    expect(plugin.source).toBe('builtin');
    expect(plugin.manifest.name).toBe('github');
    expect(plugin.manifest.tool).toBe('gh');
    expect(plugin.manifest.minToolVersion).toBe('1.9.0');
    expect(plugin.skillNames).toEqual(['baxian-cli-gh']);
  });

  it('declares the three comment sources in order with the expected carrier classes', () => {
    expect(plugin.spec.commentSources.map(s => s.key)).toEqual(['issue-comments', 'inline-comments', 'reviews']);
    expect(plugin.spec.commentSources.map(s => classifyCommentSource(s))).toEqual(['top-level', 'threaded', 'reviews']);
    expect(plugin.spec.visibilityLagSeconds).toBe(5);
  });

  it('ships in the dist bundle via the build copy step', async () => {
    const pkg = JSON.parse(await readFile(join(BUILTIN_ROOT, '../../../package.json'), 'utf8')) as { scripts: { build: string } };
    expect(pkg.scripts.build).toContain('cp -r src/platform/plugins dist/platform/plugins');
  });
});

describe('builtin github plugin: rendered argv equivalence', () => {
  const render = (opName: string) => renderCommand(plugin.spec.ops[opName]!, CTX);

  it('listPrs renders the descending updated window with explicit paging', () => {
    expect(render('listPrs')).toBe(
      "GH_HOST='github.com' 'gh' 'api' 'repos/owner/repo/pulls?state=all&sort=updated&direction=desc&per_page=10&page=3'",
    );
  });

  it('prView and projectView hit the REST resources directly', () => {
    expect(render('prView')).toBe("GH_HOST='github.com' 'gh' 'api' 'repos/owner/repo/pulls/42'");
    expect(render('projectView')).toBe("GH_HOST='github.com' 'gh' 'api' 'repos/owner/repo'");
  });

  it('branchView queries the bound repository id and qualified ref', () => {
    expect(render('branchView')).toBe(
      "GH_HOST='github.com' 'gh' 'api' 'graphql' '-f' 'repositoryId=R_repo123' '-f' " +
      "'refName=refs/heads/bx/task-1' '-f' " +
      "'query=query($repositoryId:ID!,$refName:String!){node(id:$repositoryId){... on Repository{id ref(qualifiedName:$refName){target{oid}}}}}'",
    );
  });

  it('merge carries the squash method and the atomic expected-head sha', () => {
    expect(render('merge')).toBe(
      `GH_HOST='github.com' 'gh' 'api' '-X' 'PUT' 'repos/owner/repo/pulls/42/merge' '-f' 'merge_method=squash' '-f' 'sha=${SHA}'`,
    );
  });

  it('close patches state without attaching a comment', () => {
    expect(render('close')).toBe(
      "GH_HOST='github.com' 'gh' 'api' '-X' 'PATCH' 'repos/owner/repo/pulls/42' '-f' 'state=closed'",
    );
  });

  it('deleteBranch renders updateRefs with the expected tip and repository id', () => {
    const cmd = render('deleteBranch');
    expect(cmd).toContain("'repositoryId=R_repo123'");
    expect(cmd).toContain("'refName=refs/heads/bx/task-1'");
    expect(cmd).toContain(`'beforeOid=${SHA}'`);
    expect(cmd).toContain('$refName:GitRefname!');
    expect(cmd).toContain('updateRefs');
    expect(cmd).not.toContain("'-X' 'DELETE'");
  });

  it('the three comment sources page through their endpoints', () => {
    const [issues, inline, reviews] = plugin.spec.commentSources.map(s => renderCommand(s, CTX));
    expect(issues).toBe("GH_HOST='github.com' 'gh' 'api' 'repos/owner/repo/issues/42/comments?per_page=100&page=3'");
    expect(inline).toBe("GH_HOST='github.com' 'gh' 'api' 'repos/owner/repo/pulls/42/comments?per_page=100&page=3'");
    expect(reviews).toBe("GH_HOST='github.com' 'gh' 'api' 'repos/owner/repo/pulls/42/reviews?per_page=100&page=3'");
  });
});

describe('builtin github plugin: preflight', () => {
  it('renders the two probe commands', () => {
    expect(renderCommand(plugin.spec.preflight[0]!, CTX)).toBe("'gh' '--version'");
    expect(renderCommand(plugin.spec.preflight[1]!, CTX)).toBe("GH_HOST='github.com' 'gh' 'api' 'user'");
  });

  it('fixMessages interpolate the executable and pin the supported credential classes', () => {
    const version = renderFixMessage(plugin.spec.preflight[0]!.fixMessage, { ...CTX, minToolVersion: plugin.manifest.minToolVersion });
    expect(version).toBe('该主机的 gh 需 ≥ 1.9.0，安装/升级见 https://cli.github.com');
    const auth = renderFixMessage(plugin.spec.preflight[1]!.fixMessage, { ...CTX, minToolVersion: plugin.manifest.minToolVersion });
    expect(auth).toBe(
      '在该主机运行：gh auth login --hostname github.com（受支持凭据：auth login 用户令牌 / fine-grained PAT / GitHub App user token；App installation token 不支持——无法调用 /user 自省身份）',
    );
  });
});
