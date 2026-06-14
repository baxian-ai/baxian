import { describe, it, expect } from 'vitest';
import { buildLaunchCommand } from '../../src/agent/manager.js';
import type { AgentConfig } from '../../src/shared/index.js';

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'dev-1',
    runtime: 'claude-code',
    role: 'dev',
    mode: 'local',
    ...overrides,
  };
}

describe('buildLaunchCommand', () => {
  it('claude-code: bypass mode by default', () => {
    expect(buildLaunchCommand(agent({ runtime: 'claude-code' }))).toBe(
      'env CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions',
    );
  });

  it('claude-code uses env instead of POSIX assignment syntax for shell compatibility', () => {
    const cmd = buildLaunchCommand(agent({ runtime: 'claude-code' }));

    expect(cmd).toMatch(/^env CLAUDE_CODE_NO_FLICKER=1 claude\b/);
    expect(cmd).not.toMatch(/^CLAUDE_CODE_NO_FLICKER=1\b/);
  });

  it('codex: bypass approvals by default', () => {
    expect(buildLaunchCommand(agent({ runtime: 'codex' }))).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('claude-code with --model', () => {
    expect(buildLaunchCommand(agent({ runtime: 'claude-code', model: 'sonnet' }))).toBe(
      "env CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --model 'sonnet'",
    );
  });

  it('codex with --model', () => {
    expect(buildLaunchCommand(agent({ runtime: 'codex', model: 'o3' }))).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox --model 'o3'",
    );
  });

  it('claude-code with single --add-dir', () => {
    expect(buildLaunchCommand(agent({ runtime: 'claude-code', addDirs: ['/usr/local/lib'] }))).toBe(
      "env CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --add-dir '/usr/local/lib'",
    );
  });

  it('codex with multiple --add-dir flags (one per dir)', () => {
    expect(
      buildLaunchCommand(agent({ runtime: 'codex', addDirs: ['/a', '/b', '/c'] })),
    ).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox --add-dir '/a' --add-dir '/b' --add-dir '/c'",
    );
  });

  it('claude-code with both --model and --add-dir', () => {
    expect(
      buildLaunchCommand(agent({ runtime: 'claude-code', model: 'opus', addDirs: ['/x'] })),
    ).toBe("env CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --model 'opus' --add-dir '/x'");
  });

  it('empty addDirs array is a no-op', () => {
    expect(buildLaunchCommand(agent({ runtime: 'claude-code', addDirs: [] }))).toBe(
      'env CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions',
    );
  });

  it('shell-quotes model values containing single quotes (injection guard)', () => {
    const cmd = buildLaunchCommand(agent({ runtime: 'codex', model: "evil'; rm -rf /;'" }));
    expect(cmd).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox --model 'evil'\\''; rm -rf /;'\\'''",
    );
    // Invariant: the only unquoted ' chars are exactly the `'\''` triplets.
    const modelArg = cmd.split(' --model ')[1];
    const stripped = modelArg.replace(/'\\''/g, '');
    // After collapsing the close-escape-reopen triplets, the remaining string
    // must start with ' and end with ' (the outer quotes), with no bare `'`
    // inside — proving every embedded apostrophe was properly escaped.
    expect(stripped.startsWith("'")).toBe(true);
    expect(stripped.endsWith("'")).toBe(true);
    expect(stripped.slice(1, -1)).not.toContain("'");
  });

  it('shell-quotes addDirs with spaces and metacharacters', () => {
    const cmd = buildLaunchCommand(
      agent({ runtime: 'claude-code', addDirs: ['/path with space/$(whoami)'] }),
    );
    expect(cmd).toBe(
      "env CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --add-dir '/path with space/$(whoami)'",
    );
  });
});
