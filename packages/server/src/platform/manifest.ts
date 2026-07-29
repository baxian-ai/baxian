import { PluginManifest, PluginValidationError } from './types.js';
import { isRecord, TOOL_PATTERN } from '../shared/index.js';

const SEMVER = /^(\d{1,10})\.(\d{1,10})\.(\d{1,10})$/;

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
    return {
      errors,
      name: typeof m.name === 'string' && m.name !== '' ? m.name : undefined,
      tool: typeof m.tool === 'string' && TOOL_PATTERN.test(m.tool) ? m.tool : undefined,
    };
  }
  return { manifest: m as unknown as PluginManifest };
}
