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

// driverSchema 1 加载期契约（spec §5.3 增量⑥）：仅查「已声明字段合法」挡不住整键省略——
// 漏 sourceProjectId 会让 fork 防护恒等式静默成立，装机期拒载优于运行期静默失败。
const REQUIRED_OPS = ['listPrs', 'prView', 'projectView', 'listComments', 'merge', 'close', 'deleteBranch'] as const;
// treatAsSuccess 的语义是「错误已证明目标状态达成」的幂等写——权威读取没有这种状态，
// 声明在读 op 上会把 404/权限失败折叠成空行集或截断页并以 ok 进完整性门。
const TREAT_AS_SUCCESS_LABEL = [...WRITE_OPS].join('/');
// 写 op 不消费作用域/原子保护占位符时 schema 照常通过，但 merge 会失去 REST sha 陈旧保护、
// close/deleteBranch 可指向固定资源——占位符消费纳入加载期契约（argv 与 env 值合并检查）。
const REQUIRED_OP_PLACEHOLDERS: ReadonlyArray<readonly [string, readonly string[][]]> = [
  ['merge', [['prNumber'], ['expectedHeadSha']]],
  ['close', [['prNumber']]],
  ['deleteBranch', [['branch', 'branchEncoded']]],
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
  projectView: ['defaultBranch'],
};
const REQUIRED_COMMENT_SOURCE_FIELDS = ['id', 'body'] as const;
const RESERVED_ERROR_CLASSES: ReadonlyArray<readonly [string, string]> = [
  ['ACCESS_DENIED', 'core'], ['RATE_LIMIT', 'core'], ['NOT_FOUND', 'core'],
  ['MERGE_BLOCKED', 'merge'], ['REF_NOT_FOUND', 'deleteBranch'],
];
// Cf = 零宽空格/BOM/方向控制等不可见格式字符：trim() 不归一，肉眼与日志均不可见，键恒查不到。
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

  // 先查 token 形状（防 {prNumber1} 等 typo 被"只认合法形状"的正则直接跳过），形状合法再查白名单。
  const checkPlaceholders = (s: string, ctx: string, allowed: ReadonlySet<string>) => {
    for (const m of s.matchAll(PLACEHOLDER_TOKEN_RE)) {
      const name = m[1];
      if (!VALID_PLACEHOLDER_NAME_RE.test(name)) {
        err(`${ctx}: malformed placeholder token {${name}}`);
        continue;
      }
      if (!allowed.has(name)) err(`${ctx}: unknown placeholder {${name}}`);
    }
    // 不成对/嵌套的大括号不构成完整 token，上面的扫描不报、渲染时字面量直进命令行——单独拒绝。
    const stripped = s.replace(PLACEHOLDER_TOKEN_RE, '');
    if (stripped.includes('{') || stripped.includes('}')) {
      err(`${ctx}: unbalanced '{' or '}' in '${s}' (placeholders must be complete {name} tokens)`);
    }
  };

  // 段形态谓词单点定义（map 源路径与 op 级 flatten 共用）：空段/空白段/残留方括号/不可见
  // 格式字符/控制字符都会被取值器当普通键名查找而恒缺失——加载期拒绝。
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

  // argv/env 的形状规则在 ops 与 preflight 两个语境完全一致，仅占位符白名单不同——单点维护。
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
      // env 值经 shellQuote 渲染为命令内联前缀，控制字符无合法用途，校验期拒绝（spec §4）。
      if (CONTROL_CHAR_RE.test(v)) {
        err(`${ctx}.env value for ${k} contains a control character`);
        continue;
      }
      checkPlaceholders(v, `${ctx}.env`, allowed);
    }
  };

  // errorClasses 先于 ops 校验：ops 的 treatAsSuccess 引用比对直接消费这里收集的合法类名，
  // 免得再维护一份「宽松预收集」的第二定义（何为已声明的 class 只有一个答案）。
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
        // 匹配按声明序先到先得，重复类名让后者静默不可达且 treatAsSuccess 引用歧义。
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
            // 恒匹配的正则必匹配空串（'|'/'.*'/'^'/'(?:)'…）——错误分类必须锚定具体错误文本，
            // 否则被 treatAsSuccess 引用时把权限/项目错误吞成幂等成功。
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
    // argv 坏只跳过依赖它的 {page} 检查（join 会在非数组上崩）；env/map/flatten 不依赖 argv，照常单遍聚合校验（与下方 preflight 一致，作者不必多轮试错）。
    const argvOk = checkArgv(op.argv, ctx, allowed);
    checkEnv(op.env, ctx, allowed);

    if (op.parse !== undefined && op.parse !== 'json' && op.parse !== 'json-paged') {
      err(`${ctx}.parse must be 'json' | 'json-paged'`);
    } else if (op.parse === 'json-paged' && argvOk && !op.argv.join(' ').includes('{page}')) {
      err(`${ctx}.argv must include a {page} token when parse is 'json-paged'`);
    }

    if (op.flatten !== undefined && (typeof op.flatten !== 'string' || op.flatten.trim() === '')) {
      err(`${ctx}.flatten must be a non-empty string`);
    } else if (typeof op.flatten === 'string' && op.flatten.split('.').some(isMalformedSegment)) {
      // op 级 flatten 是纯点路径（spec §5.3），[] 语法只属于 map source；getPath 按字面键查，
      // 'notes[]'/空段会恒查不到而静默零行。
      err(`${ctx}.flatten must be a dot path of non-empty segments without '[]' (got '${op.flatten}')`);
    }

    const mapContainer = checkContainer(op.map, `${ctx}.map`);
    if (mapContainer) {
      for (const [field, value] of Object.entries(mapContainer)) {
        if (!MAP_TARGET_FIELDS.has(field)) err(`${ctx}.map.${field}: not in the closed target field set`);
        const checkDiscussionRef = (src: string) => {
          // '_discussion' 是保留的父引用前缀：裸用无语义；无 flatten 时 parent===element，
          // 前缀会静默退化为对元素自身的取值——两种形态都按声明错误拒绝。
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
    return `${argvText} ${envText}`;
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

  // 声明层契约与 optional 值层无关：{sources, optional: true} 是合法声明，整键省略才拒载。
  const requireDeclaredFields = (opValue: unknown, ctx: string, fields: readonly string[]) => {
    if (!isRecord(opValue)) return;
    const rawMap = (opValue as unknown as DriverOp).map;
    const map = isRecord(rawMap) ? rawMap : rawMap === undefined ? {} : undefined;
    if (map === undefined) return; // 非法形状已由 checkContainer 报错
    for (const field of fields) {
      if (!(field in map)) err(`${ctx}.map.${field} must be declared (lifecycle-required mapping)`);
    }
    return map;
  };

  // core 以显式 {page} 循环驱动这些 op（spec §5.3 分页执行模型）：非 paged 形态到运行期才会
  // 以「重复页/页上限」误诊暴露，装机时报错优于运行期降级。
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
      // 完整性门要求全部源当周期成功（spec §6 verdict ①），「可选源」与之矛盾。
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
    // body/时间戳若声明成 optional，后端整键省略会静默折叠为「无正文/无时间戳」——反馈被吞而
    // 健康度全绿（sourceProjectId 同型静默失败）。「值可空」用 null-as-present 表达即可（非
    // optional 映射对 null 值不报错，GitHub 纯 APPROVED review 的 body: null 属值层）。body 对
    // **全部**源禁 optional——豁免若按 reviews 类给，装饰性 reviewState 声明即可伪造类别绕开；
    // 时间戳豁免限 reviews 类（PENDING 的 submitted_at 键可缺失——github OpenAPI 非 required，
    // undated 行级跳过 + 一次性日志承接，spec §5.3 增量①），伪造类别换到的只是这份有界、
    // 日志可见的降级，吞不掉带正文的反馈。
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
    // 空数组声明了 op 键却零源：裁决与反馈生命周期静默永久挂起，与整键省略同级拒载。
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
  // parse 形态按 op 契约钉死：单资源读缺 parse 会恒零行、绕过基数检查静默停摆；
  // 写 op 声明 json-paged 能通过装载、却在唯一执行入口 runOp 被拒——两个方向都装机期报错。
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
  // treatAsSuccess 允许域覆盖全部声明 op（加载门必须与运行期折叠机制同覆盖面——只罩必需
  // op 会让附加 op 的读失败照样被折叠）；optional 禁令只针对生命周期必需 op（附加 op 可降级）。
  const requiredOpSet: ReadonlySet<string> = new Set(REQUIRED_OPS);
  for (const [opName, opValue] of Object.entries(rawOps)) {
    if (opName === 'listComments' || !isRecord(opValue)) continue;
    const op = opValue as unknown as DriverOp;
    if (requiredOpSet.has(opName) && op.optional === true) {
      // 生命周期必需 op 声明 optional 是矛盾声明：调用方无从降级，运行期仍按必需失败。
      err(`ops.${opName}.optional must not be true (lifecycle-required op)`);
    }
    if (!WRITE_OPS.has(opName) && op.treatAsSuccess !== undefined) {
      err(`ops.${opName}.treatAsSuccess is only allowed on ${TREAT_AS_SUCCESS_LABEL}`);
    }
  }
  for (const [opName, groups] of REQUIRED_OP_PLACEHOLDERS) {
    if (rawOps[opName] !== undefined) requirePlaceholders(rawOps[opName], `ops.${opName}`, groups);
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
    // manifest 的 minToolVersion 必填：没有恰好一个版本步骤，它就是装机即死的字段。
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
