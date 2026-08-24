export interface DetectionInput {
  screen: string;
  oscTitle: string;
  oscProgress?: string;
}

function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  let dashes = 0;
  while (dashes < trimmed.length && trimmed[dashes] === '─') dashes++;
  return dashes > 0 && (dashes === trimmed.length || dashes >= 3);
}

// 命中行的换行符属于该行:前缀切片要切到下一行行首,不能用 lines.join 重建
function lineStartOffset(screen: string, lines: string[], index: number): number {
  let offset = 0;
  const stop = Math.min(index, lines.length);
  for (let i = 0; i < stop; i++) offset += lines[i].length + 1;
  return Math.min(offset, screen.length);
}

function sliceFromLine(screen: string, lines: string[], index: number): string {
  return screen.slice(lineStartOffset(screen, lines, index));
}

function bottomNonEmptyLines(screen: string, lines: string[], count: number): string {
  if (count <= 0) return '';
  let start = -1;
  let found = 0;
  for (let i = lines.length - 1; i >= 0 && found < count; i--) {
    if (lines[i].trim() !== '') {
      found++;
      start = i;
    }
  }
  if (start < 0) return '';
  return sliceFromLine(screen, lines, start);
}

function topNonEmptyLines(screen: string, lines: string[], count: number): string {
  if (count <= 0) return '';
  let end = -1;
  let found = 0;
  for (let i = 0; i < lines.length && found < count; i++) {
    if (lines[i].trim() !== '') {
      found++;
      end = i;
    }
  }
  if (end < 0) return '';
  return screen.slice(0, lineStartOffset(screen, lines, end + 1));
}

function codexPromptLine(line: string): boolean {
  return line === '›' || line.startsWith('› ');
}

function afterLastPromptMarker(screen: string, lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (codexPromptLine(lines[i])) return sliceFromLine(screen, lines, i + 1);
  }
  return screen;
}

function promptBoxTopBorderIndex(lines: string[]): number {
  let borders = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isHorizontalRule(lines[i])) {
      borders++;
      if (borders === 2) return i;
    }
  }
  return -1;
}

function abovePromptBox(screen: string, lines: string[]): string {
  const top = promptBoxTopBorderIndex(lines);
  if (top < 0) return screen;
  return screen.slice(0, lineStartOffset(screen, lines, top));
}

function lastNonEmptyLine(content: string): string {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') return lines[i];
  }
  return '';
}

function promptBoxBody(screen: string, lines: string[]): string {
  const top = promptBoxTopBorderIndex(lines);
  if (top < 0) return '';
  let end = lines.length;
  for (let i = top + 1; i < lines.length; i++) {
    if (isHorizontalRule(lines[i])) {
      end = i;
      break;
    }
  }
  return screen.slice(lineStartOffset(screen, lines, top + 1), lineStartOffset(screen, lines, end));
}

function afterLastHorizontalRule(screen: string, lines: string[]): string {
  let lastRuleIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isHorizontalRule(lines[i])) lastRuleIdx = i;
  }
  if (lastRuleIdx < 0) return screen;
  return sliceFromLine(screen, lines, lastRuleIdx + 1);
}

const BOTTOM_LINES_RE = /^bottom_non_empty_lines\((\d+)\)$/;
const TOP_LINES_RE = /^top_non_empty_lines\((\d+)\)$/;

function resolveRegion(input: DetectionInput, spec: string): string | undefined {
  const trimmed = spec.trim();

  if (trimmed === 'osc_title') return input.oscTitle;
  if (trimmed === 'osc_progress') return input.oscProgress ?? '';
  if (trimmed === 'whole_recent') return input.screen;

  const lines = input.screen.split('\n');

  if (trimmed === 'after_last_prompt_marker') return afterLastPromptMarker(input.screen, lines);
  if (trimmed === 'above_prompt_box') return abovePromptBox(input.screen, lines);
  if (trimmed === 'last_non_empty_above_prompt_box') {
    return lastNonEmptyLine(abovePromptBox(input.screen, lines));
  }
  if (trimmed === 'prompt_box_body') return promptBoxBody(input.screen, lines);
  if (trimmed === 'after_last_horizontal_rule') return afterLastHorizontalRule(input.screen, lines);

  const bottomMatch = BOTTOM_LINES_RE.exec(trimmed);
  if (bottomMatch) return bottomNonEmptyLines(input.screen, lines, parseInt(bottomMatch[1], 10));

  const topMatch = TOP_LINES_RE.exec(trimmed);
  if (topMatch) return topNonEmptyLines(input.screen, lines, parseInt(topMatch[1], 10));

  return undefined;
}

const EMPTY_INPUT: DetectionInput = { screen: '', oscTitle: '' };

export function isKnownRegion(spec: string): boolean {
  return resolveRegion(EMPTY_INPUT, spec) !== undefined;
}

export function extractRegion(input: DetectionInput, spec: string): string {
  return resolveRegion(input, spec) ?? '';
}
