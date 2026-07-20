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

// 边界完整（前后不得再接数字/点/字母）排除 `2.40.0.1`、`2.40.0rc1`、`1.2.40.0`；
// 多候选一律拒绝——banner 里的日期（`built 2026.07.20`）与真实版本无法靠位置区分。
const VERSION_RE = /(?<![\w.])v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?![\w.])/g;

interface ParsedVersion {
  core: [number, number, number];
  prerelease: boolean;
}

function parseVersion(text: string): ParsedVersion | undefined {
  // gh 的常规输出同时含 `gh version X` 与 release 链接里的 `vX`：同值重复是正常形态，
  // 只有**不同**候选才是无法判定的歧义（banner 日期 + 真实版本）。
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

// semver §9：同核预发布版本低于正式版本；manifest 底线恒为正式版（x.y.z 强制）。
function versionBelow(actual: ParsedVersion, min: ParsedVersion): boolean {
  for (let i = 0; i < 3; i++) {
    const a = actual.core[i];
    const b = min.core[i];
    if (a !== b) return a < b;
  }
  return actual.prerelease && !min.prerelease;
}

// 两执行面共用；首败即止——后续步骤共享同一前置，连锁失败只会误导修复方向。
// 失败命令的原始输出只经 onFailure 交给调用方分类，绝不进返回值：结果直达
// /projects/:id/checks 响应，stdout/stderr 可能含凭据且缓冲上限达数十 MiB。
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
    // 退出码只证明可执行；版本步骤（加载期强制恰一个）须按 manifest 底线比较，不可解析即失败。
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
