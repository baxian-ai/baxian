export class ResponseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseParseError';
  }
}

export function parseJsonResponse(stdout: string): unknown {
  const s = stdout.trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new ResponseParseError(`invalid JSON response: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function parseJsonPagedPage(stdout: string): unknown[] {
  const s = stdout.trim();
  // 平台的合法空列表恒输出字面 []；exit 0 + 空 stdout 是工具/管道损坏而非空页，
  // 当空页会让整源以 ok 进完整性门、漏掉其中的 fail/反馈后照常裁决。
  if (s === '') throw new ResponseParseError('json-paged page has empty stdout (expected a JSON array, e.g. [])');

  // 最常见形态是单个合并数组：整体 parse 命中即免掉逐字符分帧扫描；
  // 失败才回退扫描器（gh --paginate 式的多数组拼接），错误语义与扫描路径一致。
  try {
    const whole = JSON.parse(s) as unknown;
    if (Array.isArray(whole)) return whole;
    throw new ResponseParseError('json-paged page is not valid JSON array framing');
  } catch (e) {
    if (e instanceof ResponseParseError) throw e;
  }

  const segments: unknown[] = [];
  const n = s.length;
  let i = 0;

  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    if (s[i] !== '[') throw new ResponseParseError('json-paged page is not valid JSON array framing');

    const segStart = i;
    let depth = 0;
    let inString = false;
    let segEnd = -1;

    while (i < n) {
      const ch = s[i];
      if (inString) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '"') inString = false;
        i++;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
        if (depth === 0) {
          segEnd = i;
          i++;
          break;
        }
      }
      i++;
    }

    if (segEnd === -1) throw new ResponseParseError('json-paged page is not valid JSON array framing');

    const segText = s.slice(segStart, segEnd + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(segText);
    } catch (e) {
      throw new ResponseParseError(`invalid JSON response: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!Array.isArray(parsed)) throw new ResponseParseError('json-paged page must be a JSON array');
    segments.push(...parsed);
  }

  return segments;
}
