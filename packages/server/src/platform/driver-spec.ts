import {
  DriverSpec, DriverOp, CommentSourceOp, MapValueSpec, PluginValidationError, PLACEHOLDERS, PREFLIGHT_PLACEHOLDERS,
  MAP_TARGET_FIELDS, ENV_KEY_PATTERN, PLACEHOLDERS_WITH_PAGE, PREFLIGHT_FIXMESSAGE_PLACEHOLDERS, SOURCE_KEY_PATTERN,
  SINGLE_RESOURCE_OPS, WRITE_OPS,
} from './types.js';
import { classifyCommentSource } from './markers.js';
import { CONTROL_CHAR_RE, isRecord } from '../shared/index.js';

const PLACEHOLDER_TOKEN_RE = /\{([^{}]*)\}/g;
const VALID_PLACEHOLDER_NAME_RE = /^[a-zA-Z]+$/;
const ERROR_CLASS_RE = /^[A-Z][A-Z0-9_]*$/;

const REQUIRED_OPS = [
  'listPrs', 'prView', 'projectView', 'branchView', 'listComments', 'comment', 'merge', 'close', 'deleteBranch',
] as const;
const TREAT_AS_SUCCESS_OPS: ReadonlySet<string> = new Set(['merge', 'close', 'deleteBranch']);
const TREAT_AS_SUCCESS_LABEL = [...TREAT_AS_SUCCESS_OPS].join('/');
const REQUIRED_OP_PLACEHOLDERS: ReadonlyArray<readonly [string, readonly string[][]]> = [
  ['merge', [['prNumber'], ['expectedHeadSha']]],
  ['comment', [['prNumber'], ['body']]],
  ['close', [['prNumber']]],
  ['deleteBranch', [['branch', 'branchEncoded'], ['expectedHeadSha'], ['remoteProjectId']]],
  ['branchView', [['branch', 'branchEncoded'], ['remoteProjectId']]],
  ['prView', [['prNumber']]],
];
const REQUIRED_MAP_FIELDS: Record<string, readonly string[]> = {
  listPrs: [
    'prNumber', 'prUrl', 'branch', 'headSha', 'state', 'draft', 'mergedAt', 'updatedAt',
    'sourceProjectId', 'targetProjectId', 'targetBranch',
  ],
  prView: [
    'prUrl', 'branch', 'headSha', 'state', 'draft', 'mergedAt',
    'sourceProjectId', 'targetProjectId', 'targetBranch',
  ],
  projectView: ['defaultBranch', 'remoteProjectId'],
  branchView: ['remoteProjectId', 'headSha'],
};
const REQUIRED_COMMENT_SOURCE_FIELDS = ['id', 'body'] as const;
const RESERVED_ERROR_CLASSES: ReadonlyArray<readonly [string, string]> = [
  ['ACCESS_DENIED', 'core'], ['RATE_LIMIT', 'core'], ['NOT_FOUND', 'core'],
  ['MERGE_BLOCKED', 'merge'],
];
const INVISIBLE_FORMAT_RE = /\p{Cf}/u;

export function parseDriverSpec(
  raw: string,
  pluginPath: string,
): { spec: DriverSpec } | { errors: PluginValidationError[] } {
  const errors: PluginValidationError[] = [];
  const err = (message: string) => errors.push({ pluginPath, message });
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    err(`driver.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return { errors };
  }
  if (!isRecord(obj)) {
    err('driver.json must be a JSON object');
    return { errors };
  }
  const spec = obj as unknown as DriverSpec;
  if (!isRecord(spec.ops)) {
    err('ops must be an object');
    return { errors };
  }

  const checkPlaceholders = (s: string, ctx: string, allowed: ReadonlySet<string>) => {
    const placeholderText = s.replace(/\\[{}]/g, '');
    for (const m of placeholderText.matchAll(PLACEHOLDER_TOKEN_RE)) {
      const name = m[1];
      if (!VALID_PLACEHOLDER_NAME_RE.test(name)) {
        err(`${ctx}: malformed placeholder token {${name}}`);
        continue;
      }
      if (!allowed.has(name)) err(`${ctx}: unknown placeholder {${name}}`);
    }
    const stripped = placeholderText.replace(PLACEHOLDER_TOKEN_RE, '');
    if (stripped.includes('{') || stripped.includes('}')) {
      err(`${ctx}: unbalanced '{' or '}' in '${s}' (placeholders must be complete {name} tokens)`);
    }
  };

  const isMalformedSegment = (key: string): boolean =>
    key === '' || key.trim() !== key || key.includes('[') || key.includes(']')
    || INVISIBLE_FORMAT_RE.test(key) || CONTROL_CHAR_RE.test(key);

  const checkSourcePath = (src: string, ctxField: string) => {
    if (src.trim() === '') {
      err(`${ctxField}: source path must be non-empty`);
      return;
    }
    const segments = src.split('.');
    if (segments.filter(seg => seg.endsWith('[]')).length > 1) {
      err(`${ctxField}: source path '${src}' has more than one '[]' level (single-level flatten only)`);
    }
    for (const seg of segments) {
      const key = seg.endsWith('[]') ? seg.slice(0, -2) : seg;
      if (isMalformedSegment(key)) {
        err(`${ctxField}: source path '${src}' has a malformed segment '${seg}' (dot path with a single trailing '[]' only)`);
        return;
      }
    }
  };

  const checkContainer = (value: unknown, ctxField: string): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
      err(`${ctxField} must be an object`);
      return undefined;
    }
    return value as Record<string, unknown>;
  };

  const checkOptionalField = (value: unknown, ctxField: string) => {
    if (value !== undefined && typeof value !== 'boolean') err(`${ctxField}.optional must be a boolean`);
  };

  const checkArgv = (argv: unknown, ctx: string, allowed: ReadonlySet<string>): boolean => {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(a => typeof a !== 'string')) {
      err(`${ctx}.argv must be a non-empty string array`);
      return false;
    }
    if (argv[0] !== '{binary}') err(`${ctx}.argv[0] must be '{binary}'`);
    for (const a of argv as string[]) checkPlaceholders(a, `${ctx}.argv`, allowed);
    return true;
  };

  const checkEnv = (env: unknown, ctx: string, allowed: ReadonlySet<string>) => {
    const container = checkContainer(env, `${ctx}.env`);
    for (const [k, v] of Object.entries(container ?? {})) {
      if (!ENV_KEY_PATTERN.test(k)) {
        err(`${ctx}.env key must match ${ENV_KEY_PATTERN} (got ${k})`);
        continue;
      }
      if (typeof v !== 'string') {
        err(`${ctx}.env values must be strings`);
        continue;
      }
      if (CONTROL_CHAR_RE.test(v)) {
        err(`${ctx}.env value for ${k} contains a control character`);
        continue;
      }
      checkPlaceholders(v, `${ctx}.env`, allowed);
    }
  };

  const checkStdin = (stdin: unknown, ctx: string, allowed: ReadonlySet<string>) => {
    if (stdin === undefined) return;
    if (typeof stdin !== 'string' || stdin.length === 0) {
      err(`${ctx}.stdin must be a non-empty string`);
      return;
    }
    checkPlaceholders(stdin, `${ctx}.stdin`, allowed);
  };

  const errorClassNames = new Set<string>();
  if (!Array.isArray(spec.errorClasses)) {
    err('errorClasses must be an array');
  } else {
    spec.errorClasses.forEach((c, i) => {
      if (!isRecord(c)) {
        err(`errorClasses[${i}] must be an object`);
        return;
      }
      if (typeof c.class !== 'string' || !ERROR_CLASS_RE.test(c.class)) {
        err(`errorClasses[${i}].class must be UPPER_SNAKE`);
      } else if (errorClassNames.has(c.class)) {
        err(`errorClasses[${i}].class duplicates '${c.class}'`);
      } else {
        errorClassNames.add(c.class);
      }
      if (!Array.isArray(c.regex) || c.regex.length === 0) err(`errorClasses[${i}].regex must be non-empty`);
      else c.regex.forEach((r, k) => {
        if (typeof r !== 'string' || r.trim() === '') {
          err(`errorClasses[${i}].regex[${k}] must be a non-empty string`);
        } else {
          try {
            if (new RegExp(r).test('')) err(`errorClasses[${i}].regex[${k}] matches the empty string (matches any stderr)`);
          } catch { err(`errorClasses[${i}].regex[${k}] invalid`); }
        }
      });
    });
  }

  const checkOp = (opValue: unknown, ctx: string): boolean => {
    if (!isRecord(opValue)) {
      err(`${ctx} must be an object`);
      return false;
    }
    const op = opValue as unknown as DriverOp;
    const allowed = op.parse === 'json-paged' ? PLACEHOLDERS_WITH_PAGE : PLACEHOLDERS;
    const argvOk = checkArgv(op.argv, ctx, allowed);
    checkEnv(op.env, ctx, allowed);
    checkStdin(op.stdin, ctx, allowed);

    if (op.parse !== undefined && op.parse !== 'json' && op.parse !== 'json-paged') {
      err(`${ctx}.parse must be 'json' | 'json-paged'`);
    } else if (op.parse === 'json-paged' && argvOk && !op.argv.join(' ').includes('{page}')) {
      err(`${ctx}.argv must include a {page} token when parse is 'json-paged'`);
    }

    if (op.responseEnvelope !== undefined && op.responseEnvelope !== 'graphql') {
      err(`${ctx}.responseEnvelope must be 'graphql' when present`);
    } else if (op.responseEnvelope === 'graphql' && op.parse === 'json-paged') {
      err(`${ctx}.responseEnvelope 'graphql' is not supported on paged ops`);
    }

    if (op.flatten !== undefined && (typeof op.flatten !== 'string' || op.flatten.trim() === '')) {
      err(`${ctx}.flatten must be a non-empty string`);
    } else if (typeof op.flatten === 'string' && op.flatten.split('.').some(isMalformedSegment)) {
      err(`${ctx}.flatten must be a dot path of non-empty segments without '[]' (got '${op.flatten}')`);
    }

    const mapContainer = checkContainer(op.map, `${ctx}.map`);
    if (mapContainer) {
      for (const [field, value] of Object.entries(mapContainer)) {
        if (!MAP_TARGET_FIELDS.has(field)) err(`${ctx}.map.${field}: not in the closed target field set`);
        const checkDiscussionRef = (src: string) => {
          if (src === '_discussion' || src.startsWith('_discussion[]')) {
            err(`${ctx}.map.${field}: '_discussion' is a reserved parent reference (use '_discussion.<field>')`);
          } else if (src.startsWith('_discussion.') && typeof op.flatten !== 'string') {
            err(`${ctx}.map.${field}: '_discussion.' parent reference requires op.flatten`);
          }
        };
        if (typeof value === 'string') {
          checkSourcePath(value, `${ctx}.map.${field}`);
          checkDiscussionRef(value);
        } else {
          if (!isRecord(value)) {
            err(`${ctx}.map.${field} must be a string or object`);
            continue;
          }
          const v = value as Exclude<MapValueSpec, string>;
          if (!Array.isArray(v.sources) || v.sources.length === 0 || v.sources.some(s => typeof s !== 'string')) {
            err(`${ctx}.map.${field}.sources must be a non-empty string array`);
          } else {
            for (const s of v.sources) {
              checkSourcePath(s, `${ctx}.map.${field}.sources`);
              checkDiscussionRef(s);
            }
          }
          checkOptionalField(v.optional, `${ctx}.map.${field}`);
          if (v.values !== undefined
            && (!isRecord(v.values) || Object.values(v.values).some(t => typeof t !== 'string'))) {
            err(`${ctx}.map.${field}.values must be a string-to-string record`);
          }
        }
      }
    }

    checkOptionalField(op.optional, ctx);

    if (op.treatAsSuccess !== undefined) {
      if (!Array.isArray(op.treatAsSuccess) || op.treatAsSuccess.some(c => typeof c !== 'string')) {
        err(`${ctx}.treatAsSuccess must be a string array`);
      } else {
        for (const c of op.treatAsSuccess) {
          if (!errorClassNames.has(c)) err(`${ctx}.treatAsSuccess references an undeclared error class '${c}'`);
        }
      }
    }
    return true;
  };

  const opAllText = (opValue: unknown): string => {
    const op = opValue as DriverOp;
    const argvText = Array.isArray(op.argv) ? op.argv.filter(a => typeof a === 'string').join(' ') : '';
    const envText = isRecord(op.env) ? Object.values(op.env).filter(v => typeof v === 'string').join(' ') : '';
    const stdinText = typeof op.stdin === 'string' ? op.stdin : '';
    return `${argvText} ${envText} ${stdinText}`;
  };

  const requirePlaceholders = (opValue: unknown, ctx: string, groups: readonly string[][]) => {
    if (!isRecord(opValue)) return;
    const text = opAllText(opValue);
    for (const group of groups) {
      if (!group.some(name => text.includes(`{${name}}`))) {
        err(`${ctx} must consume ${group.map(n => `{${n}}`).join(' or ')} (lifecycle scope/atomicity contract)`);
      }
    }
  };

  const rawOps = spec.ops as Record<string, unknown>;
  for (const [opName, op] of Object.entries(rawOps)) {
    if (opName === 'listComments') continue;
    checkOp(op, `ops.${opName}`);
  }

  const checkSourceKey = (value: unknown, ctx: string): string | undefined => {
    if (typeof value !== 'string' || !SOURCE_KEY_PATTERN.test(value)) {
      err(`${ctx}.key must match ${SOURCE_KEY_PATTERN} (got ${JSON.stringify(value)})`);
      return undefined;
    }
    return value;
  };

  const requireDeclaredFields = (opValue: unknown, ctx: string, fields: readonly string[]) => {
    if (!isRecord(opValue)) return;
    const rawMap = (opValue as unknown as DriverOp).map;
    const map = isRecord(rawMap) ? rawMap : rawMap === undefined ? {} : undefined;
    if (map === undefined) return;
    for (const field of fields) {
      if (!(field in map)) err(`${ctx}.map.${field} must be declared (lifecycle-required mapping)`);
    }
    return map;
  };

  const requirePagedParse = (opValue: unknown, ctx: string) => {
    if (isRecord(opValue) && (opValue as unknown as DriverOp).parse !== 'json-paged') {
      err(`${ctx}.parse must be 'json-paged'`);
    }
  };

  const isOptionalDeclaration = (map: Record<string, unknown>, field: string): boolean => {
    const v = map[field];
    return isRecord(v) && (v as { optional?: boolean }).optional === true;
  };

  const checkCommentSourceContract = (src: unknown, ctx: string) => {
    requirePagedParse(src, ctx);
    requirePlaceholders(src, ctx, [['prNumber']]);
    if (isRecord(src) && (src as unknown as DriverOp).optional !== undefined) {
      err(`${ctx}.optional is not allowed on a comment source (completeness gate covers every source)`);
    }
    if (isRecord(src) && (src as unknown as DriverOp).treatAsSuccess !== undefined) {
      err(`${ctx}.treatAsSuccess is only allowed on ${TREAT_AS_SUCCESS_LABEL}`);
    }
    const map = requireDeclaredFields(src, ctx, REQUIRED_COMMENT_SOURCE_FIELDS);
    if (!map) return;
    if (!('createdAt' in map) && !('updatedAt' in map)) {
      err(`${ctx} must declare at least one of createdAt/updatedAt`);
    }
    if ('body' in map && isOptionalDeclaration(map, 'body')) {
      err(`${ctx}.map.body must not be optional (null-as-present already covers empty values)`);
    }
    if (classifyCommentSource({ map }) !== 'reviews') {
      const timestamps = ['createdAt', 'updatedAt'].filter(f => f in map);
      if (timestamps.length > 0 && timestamps.every(f => isOptionalDeclaration(map, f))) {
        err(`${ctx} must declare at least one non-optional createdAt/updatedAt on a non-reviews source`);
      }
    }
  };

  const commentSources: CommentSourceOp[] = [];
  const rawListComments = rawOps.listComments;
  if (Array.isArray(rawListComments)) {
    if (rawListComments.length === 0) err('ops.listComments must declare at least one source');
    const seenKeys = new Set<string>();
    rawListComments.forEach((src, i) => {
      const ctx = `ops.listComments[${i}]`;
      if (!checkOp(src, ctx)) return;
      checkCommentSourceContract(src, ctx);
      const key = checkSourceKey((src as Record<string, unknown>).key, ctx);
      if (key === undefined) return;
      if (seenKeys.has(key)) {
        err(`${ctx}.key duplicates '${key}'`);
        return;
      }
      seenKeys.add(key);
      commentSources.push({ ...(src as DriverOp), key });
    });
  } else if (rawListComments !== undefined && checkOp(rawListComments, 'ops.listComments')) {
    checkCommentSourceContract(rawListComments, 'ops.listComments');
    const rawKey = (rawListComments as Record<string, unknown>).key;
    const key = rawKey === undefined ? 'default' : checkSourceKey(rawKey, 'ops.listComments');
    if (key !== undefined) commentSources.push({ ...(rawListComments as DriverOp), key });
  }

  for (const opName of REQUIRED_OPS) {
    if (rawOps[opName] === undefined) err(`ops.${opName} is required by driverSchema 1`);
  }
  if (rawOps.listPrs !== undefined) requirePagedParse(rawOps.listPrs, 'ops.listPrs');
  for (const [opName, fields] of Object.entries(REQUIRED_MAP_FIELDS)) {
    if (rawOps[opName] !== undefined) requireDeclaredFields(rawOps[opName], `ops.${opName}`, fields);
  }
  for (const opName of SINGLE_RESOURCE_OPS) {
    const op = rawOps[opName];
    if (op !== undefined && isRecord(op) && (op as unknown as DriverOp).parse !== 'json') {
      err(`ops.${opName}.parse must be 'json' (single-resource read)`);
    }
  }
  for (const opName of WRITE_OPS) {
    const op = rawOps[opName];
    if (op !== undefined && isRecord(op) && (op as unknown as DriverOp).parse === 'json-paged') {
      err(`ops.${opName}.parse must not be 'json-paged' (write ops run through runOp, which has no page loop)`);
    }
  }
  const requiredOpSet: ReadonlySet<string> = new Set(REQUIRED_OPS);
  for (const [opName, opValue] of Object.entries(rawOps)) {
    if (opName === 'listComments' || !isRecord(opValue)) continue;
    const op = opValue as unknown as DriverOp;
    if (requiredOpSet.has(opName) && op.optional === true) {
      err(`ops.${opName}.optional must not be true (lifecycle-required op)`);
    }
    if (!TREAT_AS_SUCCESS_OPS.has(opName) && op.treatAsSuccess !== undefined) {
      err(`ops.${opName}.treatAsSuccess is only allowed on ${TREAT_AS_SUCCESS_LABEL}`);
    }
  }
  for (const [opName, groups] of REQUIRED_OP_PLACEHOLDERS) {
    if (rawOps[opName] !== undefined) requirePlaceholders(rawOps[opName], `ops.${opName}`, groups);
  }
  if (isRecord(rawOps.comment)) {
    const comment = rawOps.comment as unknown as DriverOp;
    const argvText = Array.isArray(comment.argv)
      ? comment.argv.filter(a => typeof a === 'string').join(' ')
      : '';
    const envText = isRecord(comment.env)
      ? Object.values(comment.env).filter(v => typeof v === 'string').join(' ')
      : '';
    if (`${argvText} ${envText}`.includes('{body}')) {
      err('ops.comment must not inline {body} in argv/env; transport it through stdin');
    }
    if (comment.stdin !== '{body}') {
      err("ops.comment.stdin must be exactly '{body}'");
    }
  }
  for (const [cls, requiredBy] of RESERVED_ERROR_CLASSES) {
    if (requiredBy !== 'core' && rawOps[requiredBy] === undefined) continue;
    if (!errorClassNames.has(cls)) err(`errorClasses must declare '${cls}' (reserved, required by ${requiredBy})`);
  }

  let visibilityLagSeconds = 5;
  const rawLag = (obj as Record<string, unknown>).visibilityLagSeconds;
  if (rawLag !== undefined) {
    if (typeof rawLag !== 'number' || !Number.isFinite(rawLag) || rawLag <= 0) {
      err(`visibilityLagSeconds must be a positive number (got ${JSON.stringify(rawLag)})`);
    } else {
      visibilityLagSeconds = rawLag;
    }
  }

  if (!Array.isArray(spec.preflight)) {
    err('preflight must be an array');
  } else {
    let versionSteps = 0;
    spec.preflight.forEach((step, i) => {
      const ctx = `preflight[${i}]`;
      if (!isRecord(step)) {
        err(`${ctx} must be an object`);
        return;
      }
      checkArgv(step.argv, ctx, PREFLIGHT_PLACEHOLDERS);
      checkEnv(step.env, ctx, PREFLIGHT_PLACEHOLDERS);
      if (typeof step.fixMessage !== 'string' || step.fixMessage === '') err(`${ctx}.fixMessage must be a non-empty string`);
      else checkPlaceholders(step.fixMessage, `${ctx}.fixMessage`, PREFLIGHT_FIXMESSAGE_PLACEHOLDERS);
      if (step.versionCheck !== undefined && typeof step.versionCheck !== 'boolean') {
        err(`${ctx}.versionCheck must be a boolean when present`);
      }
      if (step.versionCheck === true) versionSteps += 1;
    });
    if (versionSteps !== 1) {
      err(`preflight must declare exactly one versionCheck step (got ${versionSteps})`);
    }
  }

  const COMMAND_NAME_RE = /^[a-z0-9_.-]+$/i;
  let agentCommands: string[][] = [];
  if (spec.agentCommands !== undefined) {
    if (!Array.isArray(spec.agentCommands)) {
      err('agentCommands must be an array of command-alternative groups');
    } else {
      spec.agentCommands.forEach((group, i) => {
        if (!Array.isArray(group) || group.length === 0) {
          err(`agentCommands[${i}] must be a non-empty array of command names`);
          return;
        }
        for (const cmd of group) {
          if (typeof cmd !== 'string' || !COMMAND_NAME_RE.test(cmd)) {
            err(`agentCommands[${i}] entries must be plain command names (got ${JSON.stringify(cmd)})`);
          }
        }
      });
      if (errors.length === 0) agentCommands = spec.agentCommands as string[][];
    }
  }

  if (errors.length > 0) return { errors };
  const ops: Record<string, DriverOp> = {};
  for (const [name, op] of Object.entries(rawOps)) {
    if (name !== 'listComments') ops[name] = op as DriverOp;
  }
  return {
    spec: {
      ops,
      commentSources,
      visibilityLagSeconds,
      preflight: spec.preflight,
      agentCommands,
      errorClasses: spec.errorClasses,
    },
  };
}
