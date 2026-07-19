import type { DriverOp, MapValueSpec } from './types.js';

export type MappedRow = Record<string, unknown>;

export class FieldMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldMappingError';
  }
}

const MISSING: unique symbol = Symbol('missing');

function getPath(obj: unknown, path: string): unknown | typeof MISSING {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return MISSING;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// map 源路径取值器：点路径 + 单层 [] 展平（spec §5.3），供 resolveField 使用；
// op 级 flatten（上面的 getPath）语义不同（缺失/非数组按形状损坏拒绝），两者不合并。
function resolveSourceSegments(
  obj: unknown, segments: string[], fullPath: string, opName: string, field: string,
): unknown | typeof MISSING {
  if (segments.length === 0) return obj;
  if (obj === null || typeof obj !== 'object') return MISSING;
  const record = obj as Record<string, unknown>;
  const [seg, ...rest] = segments;

  if (!seg.endsWith('[]')) {
    if (!Object.hasOwn(record, seg)) return MISSING;
    return resolveSourceSegments(record[seg], rest, fullPath, opName, field);
  }

  const key = seg.slice(0, -2);
  if (!Object.hasOwn(record, key)) return MISSING; // 数组键本身不存在 → MISSING，走必需/optional 语义
  const arr = record[key];
  // null-as-present（spec §5.3）：键存在值 null 不触发任何缺失语义；集合投影统一空数组，
  // 与 [] 响应同构、required 不抛。仅键不存在才是 MISSING。
  if (arr === null) return [];
  if (!Array.isArray(arr)) {
    throw new FieldMappingError(
      `op ${opName}: field '${field}' source path '${fullPath}' expects an array at '${key}' (got ${typeof arr})`,
    );
  }
  const results: unknown[] = [];
  for (const element of arr) {
    const v = resolveSourceSegments(element, rest, fullPath, opName, field);
    if (v !== MISSING) results.push(v); // 元素缺剩余路径键则跳过该元素（宽松聚合）
  }
  return results;
}

// map 对一次 mapResponse 恒定：路径 split 与双层 [] 检查在行循环前编译一次，行内只消费。
interface CompiledSource { fromParent: boolean; segments: string[]; raw: string }
interface CompiledField {
  field: string; sources: CompiledSource[]; sourceKeys: string; optional: boolean;
  values?: Record<string, string>;
}

function compileMap(opName: string, map: Record<string, MapValueSpec>): CompiledField[] {
  return Object.entries(map).map(([field, spec]) => {
    const rawSources = typeof spec === 'string' ? [spec] : spec.sources;
    const optional = typeof spec === 'string' ? false : spec.optional === true;
    const values = typeof spec === 'string' ? undefined : spec.values;
    const sources = rawSources.map((raw): CompiledSource => {
      const fromParent = raw.startsWith('_discussion.');
      const path = fromParent ? raw.slice('_discussion.'.length) : raw;
      const segments = path.split('.');
      if (segments.filter(seg => seg.endsWith('[]')).length > 1) {
        throw new FieldMappingError(
          `op ${opName}: field '${field}' source path '${path}' has more than one '[]' level, which is unsupported`,
        );
      }
      return { fromParent, segments, raw: path };
    });
    return { field, sources, sourceKeys: rawSources.join(', '), optional, values };
  });
}

function resolveField(
  opName: string, compiled: CompiledField,
  element: unknown, parent: unknown,
): unknown {
  for (const src of compiled.sources) {
    const v = resolveSourceSegments(src.fromParent ? parent : element, src.segments, src.raw, opName, compiled.field);
    if (v !== MISSING) {
      // values 翻译只作用于字符串命中（spec §5.3 增量③）：null/数字等命中原样透传。
      if (compiled.values && typeof v === 'string' && Object.hasOwn(compiled.values, v)) return compiled.values[v];
      return v; // null 是合法值，键存在即命中
    }
  }
  if (compiled.optional) return undefined;
  throw new FieldMappingError(`op ${opName}: required field '${compiled.field}' missing (tried keys: ${compiled.sourceKeys})`);
}

export function mapResponse(opName: string, op: DriverOp, payload: unknown): MappedRow[] {
  const compiledFields = compileMap(opName, op.map ?? {});
  const units: Array<{ element: unknown; parent: unknown }> = [];

  // null 或非对象 payload 按零行处理
  if (payload === null || typeof payload !== 'object') {
    return [];
  }

  const top = Array.isArray(payload) ? payload : [payload];
  for (const item of top) {
    if (op.flatten) {
      const arr = getPath(item, op.flatten);
      // 键缺失/非数组是响应形状损坏而非空集合：静默跳过会把整页伪装成合法空页，被跳过的
      // discussion 若含令牌或人类反馈，完整性门照样放行——fail closed；显式 null/[] 才是空集合。
      if (arr === MISSING) {
        throw new FieldMappingError(`op ${opName}: flatten path '${op.flatten}' missing on a response item`);
      }
      if (arr === null) continue;
      if (!Array.isArray(arr)) {
        throw new FieldMappingError(`op ${opName}: flatten path '${op.flatten}' expects an array (got ${typeof arr})`);
      }
      for (const child of arr) units.push({ element: child, parent: item });
    } else {
      units.push({ element: item, parent: item });
    }
  }
  return units.map(({ element, parent }) => {
    const row: MappedRow = {};
    for (const compiled of compiledFields) {
      row[compiled.field] = resolveField(opName, compiled, element, parent);
    }
    return row;
  });
}
