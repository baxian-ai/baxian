export interface Gate {
  contains?: string[];
  regex?: string[];
  lineRegex?: string[];
  all?: Gate[];
  any?: Gate[];
  not?: Gate[];
}

const regexCache = new Map<string, RegExp>();

const INLINE_FLAGS_RE = /^\(\?([ims]+)\)/;

function getCachedRegExp(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    // 规则用 Rust regex 方言:Unicode 默认开启,行首内联 flag 需转成 JS flags
    const inline = INLINE_FLAGS_RE.exec(pattern);
    const flags = inline ? inline[1] : '';
    // Rust 走 DFA,前导 .* 不要钱;JS 回溯引擎下它让每行退化成 O(L²),而 test() 本就不锚定行首
    const body = (inline ? pattern.slice(inline[0].length) : pattern).replace(/^\.\*(?![?*+])/, '');
    re = new RegExp(body, `${flags}u`);
    regexCache.set(pattern, re);
  }
  return re;
}

export function compileGate(gate: Gate): void {
  gate.regex?.forEach(getCachedRegExp);
  gate.lineRegex?.forEach(getCachedRegExp);
  gate.all?.forEach(compileGate);
  gate.any?.forEach(compileGate);
  gate.not?.forEach(compileGate);
}

export function evaluateGate(gate: Gate, text: string, lowerText = text.toLowerCase()): boolean {
  const hasMatcher =
    (gate.contains && gate.contains.length > 0)
    || (gate.regex && gate.regex.length > 0)
    || (gate.lineRegex && gate.lineRegex.length > 0)
    || (gate.all && gate.all.length > 0)
    || (gate.any && gate.any.length > 0)
    || (gate.not && gate.not.length > 0);

  if (!hasMatcher) return false;

  if (gate.contains) {
    for (const needle of gate.contains) {
      if (!lowerText.includes(needle.toLowerCase())) return false;
    }
  }

  if (gate.regex) {
    for (const pattern of gate.regex) {
      if (!getCachedRegExp(pattern).test(text)) return false;
    }
  }

  if (gate.lineRegex) {
    const lines = text.split('\n');
    for (const pattern of gate.lineRegex) {
      if (!lines.some(line => getCachedRegExp(pattern).test(line))) return false;
    }
  }

  if (gate.all) {
    for (const nested of gate.all) {
      if (!evaluateGate(nested, text, lowerText)) return false;
    }
  }

  if (gate.any && gate.any.length > 0) {
    if (!gate.any.some(nested => evaluateGate(nested, text, lowerText))) return false;
  }

  if (gate.not) {
    for (const nested of gate.not) {
      if (evaluateGate(nested, text, lowerText)) return false;
    }
  }

  return true;
}
