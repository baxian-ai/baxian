import { renderCommand, renderFixMessage, type RenderContext } from './command-renderer.js';

export interface DriverPreflightStep {
  argv: string[];
  env?: Record<string, string>;
  fixMessage: string;
  versionCheck?: boolean;
}

export interface DriverPreflightStepResult {
  step: string;
  ok: boolean;
  message: string;
}

export type PreflightStepExec = (
  command: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const VERSION_RE = /(?<![\w.])v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?![\w.])/g;

interface ParsedVersion {
  core: [number, number, number];
  prerelease: boolean;
}

function parseVersion(text: string): ParsedVersion | undefined {
  const distinct = new Map<string, ParsedVersion>();
  for (const m of text.matchAll(VERSION_RE)) {
    const parsed: ParsedVersion = {
      core: [Number(m[1]), Number(m[2]), Number(m[3])],
      prerelease: m[4] !== undefined,
    };
    distinct.set(`${parsed.core.join('.')}${m[4] ?? ''}`, parsed);
  }
  return distinct.size === 1 ? [...distinct.values()][0] : undefined;
}

function versionBelow(actual: ParsedVersion, min: ParsedVersion): boolean {
  for (let i = 0; i < 3; i++) {
    const a = actual.core[i];
    const b = min.core[i];
    if (a !== b) return a < b;
  }
  return actual.prerelease && !min.prerelease;
}

export async function runDriverPreflightSteps(
  exec: PreflightStepExec,
  steps: readonly DriverPreflightStep[],
  ctx: RenderContext & { minToolVersion: string },
  onFailure?: (step: string, rawOutput: string) => void,
): Promise<DriverPreflightStepResult[]> {
  const results: DriverPreflightStepResult[] = [];
  const minVersion = parseVersion(ctx.minToolVersion);
  for (const [i, step] of steps.entries()) {
    const name = `driver-preflight-${i + 1}`;
    const cmd = renderCommand(step, ctx);
    let failed = false;
    let output = '';
    try {
      const res = await exec(cmd);
      failed = res.exitCode !== 0;
      output = `${res.stdout}\n${res.stderr}`;
    } catch (err) {
      failed = true;
      output = err instanceof Error ? err.message : String(err);
    }
    if (!failed && step.versionCheck === true && minVersion !== undefined) {
      const actual = parseVersion(output);
      failed = actual === undefined || versionBelow(actual, minVersion);
    }
    if (failed) {
      onFailure?.(name, output);
      results.push({ step: name, ok: false, message: renderFixMessage(step.fixMessage, ctx) });
      break;
    }
    results.push({ step: name, ok: true, message: `${cmd} OK` });
  }
  return results;
}
