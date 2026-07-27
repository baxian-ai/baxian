import { describe, it, expect } from 'vitest';
import {
  renderCommand,
  renderCommandStdin,
  renderFixMessage,
  PlaceholderValueError,
} from '../../src/platform/command-renderer.js';
import { PLACEHOLDERS_WITH_PAGE, PREFLIGHT_FIXMESSAGE_PLACEHOLDERS } from '../../src/platform/types.js';

const CTX = {
  scheme: 'http' as const, hostname: 'gl.corp', host: 'gl.corp:8443',
  repoPath: 'group/sub/proj', binary: '/opt/glab', prNumber: 42,
  expectedHeadSha: 'abc123abc123abc123abc123abc123abc123abc1',
};

describe('command-renderer', () => {
  it('renders env as inline prefix and quotes argv elements', () => {
    const cmd = renderCommand({
      argv: ['{binary}', 'api', 'projects/{repoPathEncoded}/merge_requests/{prNumber}'],
      env: { GITLAB_HOST: '{scheme}://{hostname}', GITLAB_API_HOST: '{host}', API_PROTOCOL: '{scheme}' },
    }, CTX);
    expect(cmd).toMatch(/^GITLAB_HOST='http:\/\/gl\.corp' GITLAB_API_HOST='gl\.corp:8443' API_PROTOCOL='http' /);
    expect(cmd).toContain('projects/group%2Fsub%2Fproj/merge_requests/42');
    expect(cmd).toMatch(/^GITLAB_HOST=/);
  });

  it('shell metacharacters in derived values stay inert', () => {
    const cmd = renderCommand(
      { argv: ['{binary}', 'x', '{branchEncoded}'] },
      { ...CTX, branch: 'feat/$(rm -rf)' },
    );
    expect(cmd).not.toContain('$(rm');
  });

  it('value shape violations throw', () => {
    expect(() => renderCommand({ argv: ['{prNumber}'] }, { ...CTX, prNumber: -1 })).toThrow(PlaceholderValueError);
    expect(
      () => renderCommand({ argv: ['{expectedHeadSha}'] }, { ...CTX, expectedHeadSha: 'not-a-sha!' }),
    ).toThrow(PlaceholderValueError);
  });

  it('missing context value for a used placeholder throws', () => {
    expect(() => renderCommand({ argv: ['{page}'] }, CTX)).toThrow(PlaceholderValueError);
  });

  it('renderFixMessage substitutes auth guidance placeholders', () => {
    const msg = renderFixMessage(
      'glab auth login --hostname {hostname} --api-host {host} --api-protocol {scheme}；需 ≥ {minToolVersion}',
      { ...CTX, minToolVersion: '1.92.0' },
    );
    expect(msg).toBe('glab auth login --hostname gl.corp --api-host gl.corp:8443 --api-protocol http；需 ≥ 1.92.0');
  });

  it('env key with invalid shape throws', () => {
    expect(() => renderCommand(
      { argv: ['cmd'], env: { 'X=1': 'val' } },
      CTX,
    )).toThrow(PlaceholderValueError);
  });

  it('prNumber boundary: 0 throws', () => {
    expect(() => renderCommand(
      { argv: ['{prNumber}'] },
      { ...CTX, prNumber: 0 },
    )).toThrow(PlaceholderValueError);
  });

  it('prNumber boundary: non-integer throws', () => {
    expect(() => renderCommand(
      { argv: ['{prNumber}'] },
      { ...CTX, prNumber: 1.5 },
    )).toThrow(PlaceholderValueError);
  });

  it('prNumber boundary: NaN throws', () => {
    expect(() => renderCommand(
      { argv: ['{prNumber}'] },
      { ...CTX, prNumber: NaN },
    )).toThrow(PlaceholderValueError);
  });

  it('renderFixMessage output does not contain shell quotes', () => {
    const msg = renderFixMessage(
      'glab auth login --hostname {hostname}',
      { ...CTX },
    );
    expect(msg).toBe('glab auth login --hostname gl.corp');
    expect(msg).not.toContain("'");
    expect(msg).not.toContain('"');
  });

  it('every load-time placeholder is renderable (loader whitelist and renderer switch stay in sync)', () => {
    const full = {
      ...CTX,
      prNumber: 42,
      expectedHeadSha: 'abc123abc1',
      remoteProjectId: 'R_repo123',
      branch: 'bx/task-1',
      body: 'comment body',
      page: 1,
      minToolVersion: '1.92.0',
    };
    for (const name of new Set([...PLACEHOLDERS_WITH_PAGE, ...PREFLIGHT_FIXMESSAGE_PLACEHOLDERS])) {
      expect(() => renderFixMessage(`{${name}}`, full), name).not.toThrow();
    }
  });
});

describe('command-renderer: GraphQL context', () => {
  it('renders a bounded remote project id and escaped literal braces', () => {
    const cmd = renderCommand(
      { argv: ['{binary}', 'api', 'graphql', '{remoteProjectId}', 'query=query($id:ID!)\\{node(id:$id)\\{id\\}\\}'] },
      { ...CTX, remoteProjectId: 'R_repo123' },
    );
    expect(cmd).toContain("'R_repo123'");
    expect(cmd).toContain("'query=query($id:ID!){node(id:$id){id}}'");
  });

  it('rejects missing, control-bearing, and oversized remote project ids', () => {
    for (const remoteProjectId of [undefined, ' bad', 'bad\nvalue', 'x'.repeat(513)]) {
      expect(() => renderCommand(
        { argv: ['{remoteProjectId}'] },
        { ...CTX, remoteProjectId },
      )).toThrow(PlaceholderValueError);
    }
  });
});

describe('command-renderer: {branch} placeholder', () => {
  it('renders the branch verbatim with literal slashes', () => {
    const cmd = renderCommand(
      { argv: ['{binary}', 'api', '-X', 'DELETE', 'repos/{repoPath}/git/refs/heads/{branch}'] },
      { ...CTX, branch: 'bx/task-1' },
    );
    expect(cmd).toContain("'repos/group/sub/proj/git/refs/heads/bx/task-1'");
    expect(cmd).not.toContain('bx%2Ftask-1');
  });

  it('rejects traversal segments, leading slash, and out-of-alphabet characters', () => {
    for (const branch of ['bx/../evil', '/leading', 'b ranch', 'bad^name', '..']) {
      expect(() => renderCommand({ argv: ['{branch}'] }, { ...CTX, branch }))
        .toThrow(PlaceholderValueError);
    }
  });

  it('requires a branch value in context', () => {
    expect(() => renderCommand({ argv: ['{branch}'] }, CTX)).toThrow(PlaceholderValueError);
  });
});

describe('command-renderer: {body} placeholder', () => {
  it('keeps multiline shell metacharacters inside one quoted argument', () => {
    const body = 'fix `$HOME`\n$(touch /tmp/nope)\nline 3';
    const cmd = renderCommand(
      { argv: ['{binary}', 'api', '-f', 'body={body}'] },
      { ...CTX, body },
    );
    expect(cmd).toContain("'body=fix `$HOME`\n$(touch /tmp/nope)\nline 3'");
  });

  it('rejects blank and oversized comment bodies', () => {
    expect(() => renderCommand({ argv: ['{body}'] }, { ...CTX, body: '  \n' }))
      .toThrow(PlaceholderValueError);
    expect(() => renderCommand({ argv: ['{body}'] }, { ...CTX, body: 'x'.repeat(65_537) }))
      .toThrow(/exceeds 65536 bytes/);
  });

  it('rejects NUL before the command reaches the process runner', () => {
    expect(() => renderCommand({ argv: ['{body}'] }, { ...CTX, body: 'before\0after' }))
      .toThrow(/must not contain NUL/);
  });

  it('keeps a quote-heavy legal comment out of the bash -c argument and preserves it on stdin', () => {
    const body = "'".repeat(40 * 1024);
    const op = {
      argv: ['{binary}', 'api', '-F', 'body=@-'],
      stdin: '{body}',
    };

    const cmd = renderCommand(op, { ...CTX, body });
    const stdin = renderCommandStdin(op, { ...CTX, body });

    expect(cmd).toBe("'/opt/glab' 'api' '-F' 'body=@-'");
    expect(cmd).not.toContain(body);
    expect(stdin).toEqual(Buffer.from(body));
  });
});
