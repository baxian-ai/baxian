import { vi } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { BaxianConfig } from '../../src/shared/index.js';
import { initStateDir } from '../../src/state/init.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { ReviewStore } from '../../src/state/review-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { AgentManager } from '../../src/agent/manager.js';
import { TmuxSessionStatusStore } from '../../src/agent/tmux-probe-poller.js';
import type { AppContext } from '../../src/app.js';

const SKILL_NAMES = [
  'baxian-rules',
  'task-check',
  'pr-review',
  'pr-feedback',
  'pr-recheck',
  'spells',
];

export async function createTestContext(tempDir: string): Promise<AppContext> {
  await initStateDir(tempDir);

  const skillsDir = join(tempDir, 'skills');
  for (const skillName of SKILL_NAMES) {
    const skillDir = join(skillsDir, skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `# ${skillName}\nMock skill for testing.`);
  }

  const config: BaxianConfig = {
    review: { rounds: 10 },
    server: { port: 3000 },
    host: [],
    project: [{
      id: 'proj',
      repo: 'user/repo',
      merge: null,
      agent: [[
        { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: tempDir },
        { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: tempDir },
      ]],
    }],
  };

  const agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  const taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  const lockManager = new LockManager(join(tempDir, 'locks'));
  const eventLog = new EventLog(join(tempDir, 'events'));
  const eventBus = new EventBus(eventLog);
  const tmuxSessionStatusStore = new TmuxSessionStatusStore();
  const registry = new SkillRegistry(skillsDir);
  await registry.scan();

  const mockRunner = {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    // Plan A3: CommandRunner.execWithStdin added; mock returns success by default.
    execWithStdin: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  };

  const agentManager = new AgentManager({
    config,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    skillRegistry: registry,
    runnerFactory: () => mockRunner,
    platformRunner: mockRunner,
    reviewStore: new ReviewStore(join(tempDir, 'state', 'reviews')),
    imageStagingRoot: join(tempDir, 'state', 'task-images'),
  });

  return {
    config,
    agentManager,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    eventLog,
    tmuxSessionStatusStore,
  };
}
