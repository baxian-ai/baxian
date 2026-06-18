export interface Gate {
  contains?: string[];
  regex?: string[];
  lineRegex?: string[];
  all?: Gate[];
  any?: Gate[];
  not?: Gate[];
  notAfter?: Gate[];
}

const regexCache = new Map<string, RegExp>();

function getCachedRegExp(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

function findLastPositiveMatchLine(gate: Gate, lines: string[]): number {
  let last = -1;

  if (gate.contains) {
    for (const needle of gate.contains) {
      const lower = needle.toLowerCase();
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].toLowerCase().includes(lower)) {
          last = Math.max(last, i);
          break;
        }
      }
    }
  }

  if (gate.lineRegex) {
    for (const pattern of gate.lineRegex) {
      const re = getCachedRegExp(pattern);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (re.test(lines[i])) {
          last = Math.max(last, i);
          break;
        }
      }
    }
  }

  if (gate.regex) {
    for (const pattern of gate.regex) {
      const re = getCachedRegExp(pattern);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (re.test(lines[i])) {
          last = Math.max(last, i);
          break;
        }
      }
    }
  }

  if (gate.any) {
    for (const nested of gate.any) {
      last = Math.max(last, findLastPositiveMatchLine(nested, lines));
    }
  }

  if (gate.all) {
    for (const nested of gate.all) {
      last = Math.max(last, findLastPositiveMatchLine(nested, lines));
    }
  }

  return last;
}

export function evaluateGate(gate: Gate, text: string): boolean {
  const hasMatcher =
    (gate.contains && gate.contains.length > 0)
    || (gate.regex && gate.regex.length > 0)
    || (gate.lineRegex && gate.lineRegex.length > 0)
    || (gate.all && gate.all.length > 0)
    || (gate.any && gate.any.length > 0)
    || (gate.not && gate.not.length > 0);

  if (!hasMatcher) return false;

  if (gate.contains) {
    const lowerText = text.toLowerCase();
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
      if (!evaluateGate(nested, text)) return false;
    }
  }

  if (gate.any && gate.any.length > 0) {
    if (!gate.any.some(nested => evaluateGate(nested, text))) return false;
  }

  if (gate.not) {
    for (const nested of gate.not) {
      if (evaluateGate(nested, text)) return false;
    }
  }

  if (gate.notAfter && gate.notAfter.length > 0) {
    const lines = text.split('\n');
    const anchor = findLastPositiveMatchLine(gate, lines);
    if (anchor >= 0 && anchor < lines.length - 1) {
      const suffix = lines.slice(anchor + 1).join('\n');
      for (const nested of gate.notAfter) {
        if (evaluateGate(nested, suffix)) return false;
      }
    }
  }

  return true;
}
