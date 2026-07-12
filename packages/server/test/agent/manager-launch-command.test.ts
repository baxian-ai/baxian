import { describe, it, expect } from 'vitest';
import { buildLaunchCommand, skillSubdirFor } from '../../src/agent/manager.js';
import type { AgentConfig, AgentRuntime } from '../../src/shared/index.js';

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
      'env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude --permission-mode bypassPermissions',
    );
  });

  it('claude-code uses env instead of POSIX assignment syntax for shell compatibility', () => {
    const cmd = buildLaunchCommand(agent({ runtime: 'claude-code' }));

    expect(cmd).toMatch(/^env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude\b/);
    expect(cmd).not.toMatch(/^CLAUDE_CODE_NO_FLICKER=1\b/);
  });

  it('claude-code disables the session feedback survey; codex carries no such env', () => {
    expect(buildLaunchCommand(agent({ runtime: 'claude-code' }))).toContain('CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1');
    expect(buildLaunchCommand(agent({ runtime: 'codex' }))).not.toContain('CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY');
  });

  it('codex: bypass approvals by default', () => {
    expect(buildLaunchCommand(agent({ runtime: 'codex' }))).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('claude-code with --model', () => {
    expect(buildLaunchCommand(agent({ runtime: 'claude-code', model: 'sonnet' }))).toBe(
      "env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude --permission-mode bypassPermissions --model 'sonnet'",
    );
  });

  it('codex with --model', () => {
    expect(buildLaunchCommand(agent({ runtime: 'codex', model: 'o3' }))).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox --model 'o3'",
    );
  });

  it('claude-code with single --add-dir', () => {
    expect(buildLaunchCommand(agent({ runtime: 'claude-code', addDirs: ['/usr/local/lib'] }))).toBe(
      "env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude --permission-mode bypassPermissions --add-dir '/usr/local/lib'",
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
    ).toBe("env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude --permission-mode bypassPermissions --model 'opus' --add-dir '/x'");
  });

  it('empty addDirs array is a no-op', () => {
    expect(buildLaunchCommand(agent({ runtime: 'claude-code', addDirs: [] }))).toBe(
      'env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude --permission-mode bypassPermissions',
    );
  });

  it('shell-quotes model values containing single quotes (injection guard)', () => {
    const cmd = buildLaunchCommand(agent({ runtime: 'codex', model: "evil'; rm -rf /;'" }));
    expect(cmd).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox --model 'evil'\\''; rm -rf /;'\\'''",
    );
    const modelArg = cmd.split(' --model ')[1];
    const stripped = modelArg.replace(/'\\''/g, '');
    expect(stripped.startsWith("'")).toBe(true);
    expect(stripped.endsWith("'")).toBe(true);
    expect(stripped.slice(1, -1)).not.toContain("'");
  });

  it('shell-quotes addDirs with spaces and metacharacters', () => {
    const cmd = buildLaunchCommand(
      agent({ runtime: 'claude-code', addDirs: ['/path with space/$(whoami)'] }),
    );
    expect(cmd).toBe(
      "env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude --permission-mode bypassPermissions --add-dir '/path with space/$(whoami)'",
    );
  });

  it('opencode: auto-approve mode by default', () => {
    expect(buildLaunchCommand(agent({ runtime: 'opencode' }))).toBe('env OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 opencode --auto');
  });

  it('opencode with --model', () => {
    expect(buildLaunchCommand(agent({ runtime: 'opencode', model: 'anthropic/claude-sonnet-4-6' }))).toBe(
      "env OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 opencode --auto --model 'anthropic/claude-sonnet-4-6'",
    );
  });

  it('opencode drops addDirs: it has no --add-dir flag', () => {
    expect(buildLaunchCommand(agent({ runtime: 'opencode', addDirs: ['/a', '/b'] }))).toBe('env OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 opencode --auto');
  });

  it('qodercli: skip-permissions mode by default', () => {
    expect(buildLaunchCommand(agent({ runtime: 'qodercli' }))).toBe(
      'qodercli --dangerously-skip-permissions',
    );
  });

  it('qodercli with --model and --add-dir', () => {
    expect(buildLaunchCommand(agent({ runtime: 'qodercli', model: 'efficient', addDirs: ['/x'] }))).toBe(
      "qodercli --dangerously-skip-permissions --model 'efficient' --add-dir '/x'",
    );
  });

  describe('yolo: false launches the runtime in its default permission mode (issue #475)', () => {
    it.each<[AgentRuntime, string]>([
      ['claude-code', 'env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude'],
      ['codex', 'codex'],
      ['opencode', 'env OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 opencode'],
      ['qodercli', 'qodercli'],
    ])('%s drops the bypass flag', (runtime, expected) => {
      expect(buildLaunchCommand(agent({ runtime, yolo: false }))).toBe(expected);
    });

    it.each<[AgentRuntime]>([['claude-code'], ['codex'], ['opencode'], ['qodercli']])(
      '%s: explicit yolo: true matches the undefined default',
      (runtime) => {
        expect(buildLaunchCommand(agent({ runtime, yolo: true }))).toBe(
          buildLaunchCommand(agent({ runtime })),
        );
      },
    );

    it('keeps --model and --add-dir appended without the bypass flag', () => {
      expect(
        buildLaunchCommand(agent({ runtime: 'claude-code', yolo: false, model: 'opus', addDirs: ['/x'] })),
      ).toBe(
        "env CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude --model 'opus' --add-dir '/x'",
      );
    });
  });
});

describe('skillSubdirFor', () => {
  it.each<[AgentRuntime, string]>([
    ['claude-code', '.claude/skills'],
    ['codex', '.agents/skills'],
    ['opencode', '.agents/skills'],
    ['qodercli', '.qoder/skills'],
  ])('%s materializes skills under %s', (runtime, dir) => {
    expect(skillSubdirFor(runtime)).toBe(dir);
  });
});
