import { PluginManifest, PluginValidationError } from './types.js';
import { isRecord, TOOL_PATTERN } from '../shared/index.js';

const SEMVER = /^(\d{1,10})\.(\d{1,10})\.(\d{1,10})$/;

export function compareSemver(a: string, b: string): number {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) throw new Error(`invalid semver: ${!ma ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface ManifestIdentity {
  name?: string;
  tool?: string;
}

export function parseManifest(
  raw: string,
  pluginPath: string,
): { manifest: PluginManifest } | ({ errors: PluginValidationError[] } & ManifestIdentity) {
  const errors: PluginValidationError[] = [];
  const err = (message: string) => errors.push({ pluginPath, message });
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    err(`baxian-plugin.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return { errors };
  }
  if (!isRecord(obj)) {
    err('baxian-plugin.json must be a JSON object');
    return { errors };
  }
  const m = obj as Record<string, unknown>;
  if (typeof m.name !== 'string' || m.name === '') err('name must be a non-empty string');
  // version 是插件元数据：spec §5.2 未声明格式契约、无消费者对其做 semver 比较（仅 minToolVersion 比较）——非空串即可，勿收成 semver。
  if (typeof m.version !== 'string' || m.version.trim() === '') err(`version must be a non-empty string (got ${JSON.stringify(m.version)})`);
  if (m.kind !== 'git-driver') err(`kind must be 'git-driver', got ${JSON.stringify(m.kind)}`);
  if (typeof m.tool !== 'string' || !TOOL_PATTERN.test(m.tool)) {
    err(`tool must match ${TOOL_PATTERN} (got ${JSON.stringify(m.tool)})`);
  }
  if (typeof m.minToolVersion !== 'string' || !SEMVER.test(m.minToolVersion)) {
    err(`minToolVersion must be x.y.z semver (got ${JSON.stringify(m.minToolVersion)})`);
  }
  if (m.driverSchema !== 1) err(`driverSchema must be 1 (got ${JSON.stringify(m.driverSchema)})`);
  if (errors.length > 0) {
    // schema 失败仍保留各自通过格式校验的 name/tool 作 best-effort 身份——
    // startup 的同名覆盖下毒靠它识别「坏损覆盖」，丢弃会静默回退内置（spec §5.4）。
    return {
      errors,
      name: typeof m.name === 'string' && m.name !== '' ? m.name : undefined,
      tool: typeof m.tool === 'string' && TOOL_PATTERN.test(m.tool) ? m.tool : undefined,
    };
  }
  return { manifest: m as unknown as PluginManifest };
}
