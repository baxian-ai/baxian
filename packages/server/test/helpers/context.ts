import { join } from 'node:path';
import { PetStore } from '../../src/state/pet-store.js';
import { TmuxSessionStatusStore } from '../../src/agent/tmux-probe-poller.js';
import type { AppContext } from '../../src/app.js';
import { createManagerHarness } from './manager-harness.js';
import { makeConfig } from './fixtures.js';

export async function createTestContext(tempDir: string): Promise<AppContext> {
  const config = makeConfig({
    review: { rounds: 10 },
    project: [{
      id: 'proj',
      repo: 'user/repo',
      merge: null,
      agent: [[
        { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: join(tempDir, 'dev-1') },
        { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: join(tempDir, 'qa-1') },
      ]],
    }],
  });
  const harness = await createManagerHarness(tempDir, { config });
  const tmuxSessionStatusStore = new TmuxSessionStatusStore();
  const petStore = new PetStore(join(tempDir, 'state', 'pets'));

  return {
    config,
    agentManager: harness.manager,
    agentStore: harness.agentStore,
    taskStore: harness.taskStore,
    lockManager: harness.lockManager,
    eventBus: harness.eventBus,
    eventLog: harness.eventLog,
    tmuxSessionStatusStore,
    petStore,
  };
}
