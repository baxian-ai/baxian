export interface DetectionInput {
  screen: string;
  oscTitle: string;
}

function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  let dashCount = 0;
  let allDashes = true;
  for (const ch of trimmed) {
    if (ch === '─') {
      dashCount++;
    } else {
      allDashes = false;
      break;
    }
  }
  return dashCount >= 3 || (allDashes && dashCount > 0);
}

export function extractRegion(input: DetectionInput, spec: string): string {
  const trimmed = spec.trim();

  if (trimmed === 'oscTitle') return input.oscTitle;
  if (trimmed === 'whole') return input.screen;

  const lines = input.screen.split('\n');

  if (trimmed === 'afterLastHorizontalRule') {
    let lastRuleIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (isHorizontalRule(lines[i])) lastRuleIdx = i;
    }
    if (lastRuleIdx < 0) return input.screen;
    return lines.slice(lastRuleIdx + 1).join('\n');
  }

  if (trimmed === 'promptBoxBody') {
    const ruleIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (isHorizontalRule(lines[i])) ruleIndices.push(i);
    }
    if (ruleIndices.length < 2) return '';
    const topIdx = ruleIndices[ruleIndices.length - 2];
    const bottomIdx = ruleIndices[ruleIndices.length - 1];
    return lines.slice(topIdx + 1, bottomIdx).join('\n');
  }

  if (trimmed === 'afterLastPromptMarker') {
    let lastPromptIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmedLine = lines[i].trimStart();
      if (/^›\s*$/.test(trimmedLine)) {
        lastPromptIdx = i;
        break;
      }
      if (/^→ [A-Za-z0-9][\w.-]*(?:\s+git:\([^\s)]+\))?\s*$/.test(trimmedLine)) {
        let atTail = true;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() !== '') { atTail = false; break; }
        }
        if (atTail) {
          lastPromptIdx = i;
          break;
        }
      }
      if (trimmedLine.startsWith('› ') && !/^› \d+\./.test(trimmedLine)
        && i + 2 < lines.length
        && lines[i + 1].trim() === ''
        && /^\s+[A-Za-z0-9]\S*(?:\s+\S+){0,2}\s+·/.test(lines[i + 2])
      ) {
        let atTail = true;
        for (let j = i + 3; j < lines.length; j++) {
          if (lines[j].trim() !== '') { atTail = false; break; }
        }
        if (atTail) {
          lastPromptIdx = i;
          break;
        }
      }
    }
    if (lastPromptIdx < 0) return input.screen;
    return lines.slice(lastPromptIdx + 1).join('\n');
  }

  const tailMatch = trimmed.match(/^tail\((\d+)\)$/);
  if (tailMatch) {
    const count = parseInt(tailMatch[1], 10);
    return lines.slice(Math.max(0, lines.length - count)).join('\n');
  }

  const tailNonEmptyMatch = trimmed.match(/^tailNonEmpty\((\d+)\)$/);
  if (tailNonEmptyMatch) {
    const count = parseInt(tailNonEmptyMatch[1], 10);
    let lastNonEmptyIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() !== '') {
        lastNonEmptyIdx = i;
        break;
      }
    }
    if (lastNonEmptyIdx < 0) return '';
    let startIdx = lastNonEmptyIdx;
    let found = 1;
    for (let i = lastNonEmptyIdx - 1; i >= 0 && found < count; i--) {
      if (lines[i].trim() !== '') {
        found++;
        startIdx = i;
      }
    }
    return lines.slice(startIdx, lastNonEmptyIdx + 1).join('\n');
  }

  return '';
}
