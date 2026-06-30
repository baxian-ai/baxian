import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  clearRestartSentinelSync,
  writeRestartSentinelSync,
} from './restart-sentinel.js';

const APP_CLOSE_GRACE_MS = 5000;

export interface RestartCoordinatorOptions {
  app: Pick<FastifyInstance, 'close'>;
  configPath: string;
  stateDir: string;
  beforeExit?: () => Promise<void>;
}

export class RestartCoordinator {
  private restarting = false;
  private actor = 'unknown';
  private restartId = '';

  constructor(private opts: RestartCoordinatorOptions) {}

  isRestarting(): boolean {
    return this.restarting;
  }

  beginRestart(audit: { actor: string }): void {
    if (this.restarting) {
      throw new Error('restart already in progress');
    }
    this.restarting = true;
    this.actor = audit.actor;
    this.restartId = randomUUID();
  }

  async execute(): Promise<void> {
    try {
      writeRestartSentinelSync({
        stateDir: this.opts.stateDir,
        restartId: this.restartId,
        parentPid: process.pid,
        actor: this.actor,
      });
    } catch (err) {
      console.error(
        `[restart] sentinel write failed (restartId=${this.restartId}, actor=${this.actor}):`,
        err,
      );
      this.restarting = false;
      return;
    }

    try {
      await Promise.race([
        this.opts.app.close(),
        new Promise<void>(r => setTimeout(r, APP_CLOSE_GRACE_MS)),
      ]);
      if (this.opts.beforeExit) {
        await this.opts.beforeExit();
      }
      process.exit(0);
    } catch (err) {
      console.error(
        `[restart] failed before exit (restartId=${this.restartId}, actor=${this.actor}):`,
        err,
      );
      clearRestartSentinelSync(this.opts.stateDir);
      process.exit(1);
    }
  }
}
