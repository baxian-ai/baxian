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
  if (s === '') throw new ResponseParseError('json-paged page has empty stdout (expected a JSON array, e.g. [])');
  let parsed: unknown;
  try {
    parsed = JSON.parse(s) as unknown;
  } catch (e) {
    throw new ResponseParseError(`invalid JSON response: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) throw new ResponseParseError('json-paged page must be a JSON array');
  return parsed;
}
