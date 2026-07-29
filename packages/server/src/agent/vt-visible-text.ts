const S = {
  ground: 0,
  escape: 1,
  escapeIntermediate: 2,
  csiEntry: 3,
  csiParam: 4,
  csiIntermediate: 5,
  csiIgnore: 6,
  dcsEntry: 7,
  dcsParam: 8,
  dcsIntermediate: 9,
  dcsIgnore: 10,
  dcsPassthrough: 11,
  oscString: 12,
  sosPmApcString: 13,
} as const;

type State = (typeof S)[keyof typeof S];

const NON_ASCII_IGNORED: ReadonlySet<State> = new Set([
  S.oscString, S.dcsPassthrough, S.csiIgnore, S.dcsIgnore,
]);

const EXECUTES_C0: ReadonlySet<State> = new Set([
  S.ground, S.escape, S.escapeIntermediate,
  S.csiEntry, S.csiParam, S.csiIntermediate, S.csiIgnore,
]);

const CURSOR_MOVING_C0 = new Set([0x08, 0x09, 0x0a, 0x0d]);

const REMAPPED = '\x00';

const CHARSET_REMAPS: Readonly<Record<string, string>> = {
  '0': '`abcdefghijklmnopqrstuvwxyz{|}~',
  '4': '#@[\\]{|}~',
  '5': '[\\]^`{|}~',
  '6': '@[\\]^`{|}~',
  '7': '@[\\]^`{|}~',
  '=': '#@[\\]^_`{|}~',
  A: '#',
  C: '[\\]^`{|}~',
  E: '@[\\]^`{|}~',
  H: '@[\\]^`{|}~',
  K: '@[\\]{|}~',
  Q: '@[\\]^`{|}~',
  R: '#@[\\]{|}~',
  Y: '#@[\\]`{|}~',
  Z: '#@[\\]{|}',
};

const REMAPPED_CODES: ReadonlyMap<string, ReadonlySet<number>> = new Map(
  Object.entries(CHARSET_REMAPS).map(([d, chars]) => [d, new Set([...chars].map(c => c.charCodeAt(0)))]),
);

const RECOGNISED_DESIGNATORS: ReadonlySet<string> = new Set([...Object.keys(CHARSET_REMAPS), 'B']);

const MAX_CSI_PARAMS = 32;
const MAX_CSI_PARAM = 0x7fffffff;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

type Slot = 0 | 1 | 2 | 3;
interface CursorPosition { row: number; column: number }
interface Continuation extends CursorPosition {
  buffer: number;
  firstPrintedColumn: number;
  firstPrintedRow: number;
  lastPrintedColumn: number;
  lastPrintedRow: number;
  printedInScrollback: boolean;
  reliable: boolean;
  wrapPending: boolean;
}
interface CursorState extends CursorPosition {
  charset: string | undefined;
  conceal: boolean;
  continuation: Continuation | undefined;
  printSequence: number;
  reliable: boolean;
}
interface ScrollRegion { top: number; bottom: number }
const SGR_FINAL = 'm';
const POSITIONING_CSI_FINALS = new Set([...'ABCDEFGHILMZ`abdefr']);
const DESIGNATE_INTERMEDIATES: Readonly<Record<string, Slot>> = {
  '(': 0, ')': 1, '*': 2, '+': 3, '-': 1, '.': 2,
};
const LOCKING_SHIFTS: Readonly<Record<string, Slot>> = { n: 2, o: 3, '|': 3, '}': 2, '~': 1 };

function anywhereTransition(code: number): State | undefined {
  if (code === 0x1b) return S.escape;
  if (code === 0x18 || code === 0x1a) return S.ground;
  if (code < 0x80 || code > 0x9f) return undefined;
  if (code === 0x9b) return S.csiEntry;
  if (code === 0x9d) return S.oscString;
  if (code === 0x90) return S.dcsEntry;
  if (code === 0x98 || code === 0x9e || code === 0x9f) return S.sosPmApcString;
  return S.ground;
}

export class VisibleTextExtractor {
  private state: State = S.ground;
  private pendingHigh = '';
  private active: string | undefined;
  private readonly charsets: Array<string | undefined> = [undefined, undefined, undefined, undefined];
  private gl: Slot = 0;
  private savedByBuffer: Array<CursorState | undefined> = [undefined, undefined];
  private cursorByBuffer: CursorPosition[] = [
    { row: 0, column: 0 },
    { row: 0, column: 0 },
  ];
  private cursorReliableByBuffer = [true, true];
  private tabStopsReliableByBuffer = [true, true];
  private scrollRegionByBuffer: [ScrollRegion, ScrollRegion];
  private continuation: Continuation | undefined;
  private carriageReturnContinuation: Continuation | undefined;
  private contentInvalidatedByBuffer = [false, false];
  private printSequenceByBuffer = [0, 0];
  private wraparound = true;
  private originMode = false;
  private conceal = false;
  private altBuffer = 0;
  private pendingIntermediate: string | undefined;
  private csiPrefix = '';
  private csiIntermediates = '';
  private csiParamValues: number[] = [];
  private csiParamHasSub: boolean[] = [];
  private csiParamValue = 0;
  private csiParamStarted = false;
  private csiInSubParam = false;
  private csiOverflowed = false;
  private csiEightBit = false;
  private columns: number;
  private rows: number;

  constructor(columns = DEFAULT_COLUMNS, rows = DEFAULT_ROWS) {
    this.columns = this.normalizeColumns(columns);
    this.rows = this.normalizeRows(rows);
    this.scrollRegionByBuffer = [this.fullScrollRegion(), this.fullScrollRegion()];
  }

  resize(columns: number, rows = this.rows): void {
    const normalizedColumns = this.normalizeColumns(columns);
    const normalizedRows = this.normalizeRows(rows);
    if (normalizedColumns === this.columns && normalizedRows === this.rows) return;
    this.columns = normalizedColumns;
    this.rows = normalizedRows;
    this.scrollRegionByBuffer = [this.fullScrollRegion(), this.fullScrollRegion()];
    for (const cursor of this.cursorByBuffer) {
      cursor.column = Math.min(cursor.column, this.columns - 1);
      cursor.row = Math.min(cursor.row, this.rows - 1);
    }
    this.contentInvalidatedByBuffer = [true, true];
    this.cursorReliableByBuffer = [false, false];
  }

  reset(): void {
    this.state = S.ground;
    this.pendingHigh = '';
    this.fullReset();
    this.altBuffer = 0;
    this.pendingIntermediate = undefined;
    this.clearCsiCollect();
  }

  private normalizeColumns(columns: number): number {
    if (!Number.isFinite(columns) || columns < 1) return DEFAULT_COLUMNS;
    return Math.min(Math.trunc(columns), MAX_CSI_PARAM);
  }

  private normalizeRows(rows: number): number {
    if (!Number.isFinite(rows) || rows < 1) return DEFAULT_ROWS;
    return Math.min(Math.trunc(rows), MAX_CSI_PARAM);
  }

  private fullScrollRegion(): ScrollRegion {
    return { top: 0, bottom: this.rows - 1 };
  }

  private collectCsiParam(ch: string): void {
    if (ch === ';') {
      this.flushCsiParam();
      return;
    }
    if (ch === ':') {
      this.csiInSubParam = true;
      return;
    }
    if (this.csiInSubParam) return;
    this.csiParamStarted = true;
    const next = this.csiParamValue * 10 + (ch.charCodeAt(0) - 0x30);
    this.csiParamValue = next > MAX_CSI_PARAM ? MAX_CSI_PARAM : next;
  }

  private flushCsiParam(): void {
    if (this.csiParamValues.length < MAX_CSI_PARAMS) {
      this.csiParamValues.push(this.csiParamStarted ? this.csiParamValue : 0);
      this.csiParamHasSub.push(this.csiInSubParam);
    }
    this.csiParamValue = 0;
    this.csiParamStarted = false;
    this.csiInSubParam = false;
  }

  private collectCsiIntermediate(ch: string): void {
    if (this.csiIntermediates.length < 4) this.csiIntermediates += ch;
    else this.csiOverflowed = true;
  }

  private collectCsiPrefix(ch: string): void {
    if (this.csiPrefix === '') this.csiPrefix = ch;
    else this.csiOverflowed = true;
  }

  private clearCsiCollect(): void {
    this.csiPrefix = '';
    this.csiIntermediates = '';
    this.csiParamValues = [];
    this.csiParamHasSub = [];
    this.csiParamValue = 0;
    this.csiParamStarted = false;
    this.csiInSubParam = false;
    this.csiOverflowed = false;
    this.csiEightBit = false;
  }

  private setgCharset(slot: Slot, designator: string | undefined): void {
    this.charsets[slot] = designator;
    if (this.gl === slot) this.active = designator;
  }

  private setgLevel(slot: Slot): void {
    this.gl = slot;
    this.active = this.charsets[slot];
  }

  private resetCharsetSlots(): void {
    this.charsets.fill(undefined);
    this.active = undefined;
  }

  private softReset(): void {
    this.resetCharsetSlots();
    this.gl = 0;
    this.conceal = false;
    this.wraparound = true;
    this.originMode = false;
    this.scrollRegionByBuffer[this.altBuffer] = this.fullScrollRegion();
    this.savedByBuffer[this.altBuffer] = undefined;
  }

  private fullReset(): void {
    this.resetCharsetSlots();
    this.gl = 0;
    this.conceal = false;
    this.wraparound = true;
    this.savedByBuffer = [undefined, undefined];
    this.cursorByBuffer = [
      { row: 0, column: 0 },
      { row: 0, column: 0 },
    ];
    this.cursorReliableByBuffer = [true, true];
    this.tabStopsReliableByBuffer = [true, true];
    this.scrollRegionByBuffer = [this.fullScrollRegion(), this.fullScrollRegion()];
    this.continuation = undefined;
    this.carriageReturnContinuation = undefined;
    this.contentInvalidatedByBuffer = [false, false];
    this.printSequenceByBuffer = [0, 0];
    this.originMode = false;
    this.altBuffer = 0;
  }

  private selectDefaultCharset(): void {
    this.setgCharset(0, undefined);
    this.setgLevel(0);
  }

  private saveCursorState(): void {
    const cursor = this.cursorByBuffer[this.altBuffer];
    const continuation = this.continuation?.buffer === this.altBuffer
      ? { ...this.continuation }
      : undefined;
    this.savedByBuffer[this.altBuffer] = {
      charset: this.active,
      conceal: this.conceal,
      continuation,
      printSequence: this.printSequenceByBuffer[this.altBuffer],
      row: cursor.row,
      column: cursor.column,
      reliable: this.cursorReliableByBuffer[this.altBuffer],
    };
  }

  private restoreCursorState(): void {
    const saved = this.savedByBuffer[this.altBuffer];
    this.active = saved?.charset;
    this.conceal = saved?.conceal ?? false;
    const reliable = saved?.reliable ?? true;
    if (!reliable || !this.cursorReliableByBuffer[this.altBuffer]) this.contentInvalidated = true;
    const printedSinceSave = saved !== undefined
      && saved.printSequence !== this.printSequenceByBuffer[this.altBuffer];
    if (printedSinceSave && saved.continuation !== undefined) this.contentInvalidated = true;
    this.assignCursor(saved?.column ?? 0, saved?.row ?? 0);
    this.cursorReliableByBuffer[this.altBuffer] = reliable;
    if (saved?.continuation !== undefined && !printedSinceSave && !this.contentInvalidated) {
      this.continuation = { ...saved.continuation };
    }
  }

  private dispatchSgr(): void {
    for (let i = 0; i < this.csiParamValues.length; i++) {
      const param = this.csiParamValues[i];
      if (param === 38 || param === 48 || param === 58) {
        i += this.extendedColourSpan(i);
      } else if (param === 8) this.conceal = true;
      else if (param === 0 || param === 28) this.conceal = false;
    }
  }

  private extendedColourSpan(leader: number): number {
    let advance = 0;
    let cSpace = 0;
    for (;;) {
      if (this.csiParamHasSub[leader + advance]) return advance;
      const subtype = advance >= 1 ? this.csiParamValues[leader + 1] : 0;
      if ((subtype === 5 && advance + cSpace >= 2) || (subtype === 2 && advance + cSpace >= 5)) return advance;
      if (subtype) cSpace = 1;
      advance++;
      if (leader + advance >= this.csiParamValues.length || advance + cSpace >= 6) return advance;
    }
  }

  private csiParam(index = 0): number {
    return this.csiParamValues[index] || 1;
  }

  private activeScrollRegion(): ScrollRegion {
    return this.scrollRegionByBuffer[this.altBuffer];
  }

  private get contentInvalidated(): boolean {
    return this.contentInvalidatedByBuffer[this.altBuffer];
  }

  private set contentInvalidated(value: boolean) {
    this.contentInvalidatedByBuffer[this.altBuffer] = value;
  }

  private assignCursor(column: number, row: number): void {
    const cursor = this.cursorByBuffer[this.altBuffer];
    const region = this.activeScrollRegion();
    const top = this.originMode ? region.top : 0;
    const bottom = this.originMode ? region.bottom : this.rows - 1;
    cursor.column = Math.max(0, Math.min(column, this.columns - 1));
    cursor.row = Math.max(top, Math.min(row, bottom));
  }

  private setAbsoluteCursor(column: number, row: number): void {
    const region = this.activeScrollRegion();
    this.assignCursor(column, row + (this.originMode ? region.top : 0));
    this.cursorReliableByBuffer[this.altBuffer] = true;
  }

  private moveCursor(columns: number, rows: number): void {
    const cursor = this.cursorByBuffer[this.altBuffer];
    this.assignCursor(Math.min(cursor.column, this.columns - 1) + columns, cursor.row + rows);
  }

  private moveCursorToVerticalMargin(count: number, direction: 1 | -1): void {
    const cursor = this.cursorByBuffer[this.altBuffer];
    const region = this.activeScrollRegion();
    const margin = direction === 1 ? region.bottom : region.top;
    const inside = direction === 1 ? cursor.row <= margin : cursor.row >= margin;
    const row = inside
      ? direction === 1
        ? Math.min(cursor.row + count, margin)
        : Math.max(cursor.row - count, margin)
      : cursor.row + direction * count;
    this.assignCursor(cursor.column, row);
  }

  private moveToTab(direction: 1 | -1, count: number): void {
    const cursor = this.cursorByBuffer[this.altBuffer];
    if (!this.tabStopsReliableByBuffer[this.altBuffer]) {
      this.contentInvalidated = true;
      this.cursorReliableByBuffer[this.altBuffer] = false;
      return;
    }
    cursor.column = direction === 1
      ? Math.min((Math.floor(cursor.column / 8) + count) * 8, this.columns - 1)
      : Math.max(Math.ceil(cursor.column / 8) * 8 - 8 * count, 0);
  }

  private invalidateTabStops(): void {
    this.tabStopsReliableByBuffer[this.altBuffer] = false;
  }

  private shiftContinuationForScroll(region: ScrollRegion, shiftPosition: boolean): void {
    const continuation = this.continuation;
    if (continuation?.buffer !== this.altBuffer) return;
    if (region.top === 0
      && region.bottom === this.rows - 1
      && continuation.firstPrintedRow === region.top) {
      if (this.altBuffer === 1) {
        this.contentInvalidated = true;
        return;
      }
      continuation.printedInScrollback = true;
    }
    const positionInRegion = continuation.row >= region.top && continuation.row <= region.bottom;
    if (positionInRegion && continuation.row === region.top) {
      this.contentInvalidated = true;
      return;
    }
    if (positionInRegion && shiftPosition) continuation.row--;
    if (continuation.firstPrintedRow > region.top
      && continuation.firstPrintedRow <= region.bottom) {
      continuation.firstPrintedRow--;
    }
    if (continuation.lastPrintedRow > region.top
      && continuation.lastPrintedRow <= region.bottom) {
      continuation.lastPrintedRow--;
    }
  }

  private indexCursor(scrollContinuation: boolean): boolean {
    const cursor = this.cursorByBuffer[this.altBuffer];
    const region = this.activeScrollRegion();
    if (cursor.row === region.bottom) {
      this.shiftContinuationForScroll(region, scrollContinuation);
      return true;
    }
    if (cursor.row === this.rows - 1) {
      if (!scrollContinuation) this.contentInvalidated = true;
      return false;
    }
    this.assignCursor(cursor.column, cursor.row + 1);
    return true;
  }

  private setScrollRegion(): void {
    const top = this.csiParamValues[0] || 1;
    const requestedBottom = this.csiParamValues[1] || this.rows;
    const bottom = requestedBottom > this.rows ? this.rows : requestedBottom;
    if (bottom <= top) return;
    this.scrollRegionByBuffer[this.altBuffer] = { top: top - 1, bottom: bottom - 1 };
    this.setAbsoluteCursor(0, 0);
  }

  private printedColumnsOnRow(continuation: Continuation, row: number): [number, number] | undefined {
    if (row < continuation.firstPrintedRow || row > continuation.lastPrintedRow) return undefined;
    return [
      row === continuation.firstPrintedRow ? continuation.firstPrintedColumn : 0,
      row === continuation.lastPrintedRow ? continuation.lastPrintedColumn : this.columns - 1,
    ];
  }

  private eraseLineTouchesContinuation(mode: number): boolean {
    const continuation = this.continuation;
    if (continuation?.buffer !== this.altBuffer) return false;
    if (!continuation.reliable || !this.cursorReliableByBuffer[this.altBuffer]) return true;
    const cursor = this.cursorByBuffer[this.altBuffer];
    const printed = this.printedColumnsOnRow(continuation, cursor.row);
    if (printed === undefined) return false;
    if (mode === 2) return true;
    if (mode === 1) return cursor.column >= printed[0];
    if (mode !== 0 || cursor.column >= this.columns) return false;
    return cursor.column <= printed[1];
  }

  private characterEditTouchesContinuation(final: '@' | 'P' | 'X'): boolean {
    const continuation = this.continuation;
    if (continuation?.buffer !== this.altBuffer) return false;
    if (!continuation.reliable || !this.cursorReliableByBuffer[this.altBuffer]) return true;
    const cursor = this.cursorByBuffer[this.altBuffer];
    const printed = this.printedColumnsOnRow(continuation, cursor.row);
    if (printed === undefined) return false;
    const start = Math.min(cursor.column, this.columns - 1);
    if (final !== 'X') return start <= printed[1];
    const end = Math.min(start + this.csiParam() - 1, this.columns - 1);
    return start <= printed[1] && end >= printed[0];
  }

  private lineEditTouchesContinuation(): boolean {
    const continuation = this.continuation;
    if (continuation?.buffer !== this.altBuffer) return false;
    if (!continuation.reliable || !this.cursorReliableByBuffer[this.altBuffer]) return true;
    const cursor = this.cursorByBuffer[this.altBuffer];
    const region = this.activeScrollRegion();
    if (cursor.row < region.top || cursor.row > region.bottom) return false;
    return continuation.firstPrintedRow <= region.bottom
      && continuation.lastPrintedRow >= cursor.row;
  }

  private columnEditTouchesContinuation(): boolean {
    const continuation = this.continuation;
    if (continuation?.buffer !== this.altBuffer) return false;
    if (!continuation.reliable || !this.cursorReliableByBuffer[this.altBuffer]) return true;
    const cursor = this.cursorByBuffer[this.altBuffer];
    const region = this.activeScrollRegion();
    if (cursor.row < region.top || cursor.row > region.bottom) return false;
    const firstAffectedRow = Math.max(continuation.firstPrintedRow, region.top);
    const lastAffectedRow = Math.min(continuation.lastPrintedRow, region.bottom);
    if (firstAffectedRow > lastAffectedRow) return false;
    const start = Math.min(cursor.column, this.columns - 1);
    return firstAffectedRow < continuation.lastPrintedRow
      || start <= continuation.lastPrintedColumn;
  }

  private eraseDisplayToEndTouchesContinuation(): boolean {
    const continuation = this.continuation;
    if (continuation?.buffer !== this.altBuffer) return false;
    if (!continuation.reliable || !this.cursorReliableByBuffer[this.altBuffer]) return true;
    const cursor = this.cursorByBuffer[this.altBuffer];
    if (cursor.column >= this.columns) return false;
    return cursor.row < continuation.lastPrintedRow
      || (cursor.row === continuation.lastPrintedRow
        && cursor.column <= continuation.lastPrintedColumn);
  }

  private eraseDisplayToStartTouchesContinuation(): boolean {
    const continuation = this.continuation;
    if (continuation?.buffer !== this.altBuffer) return false;
    if (!continuation.reliable || !this.cursorReliableByBuffer[this.altBuffer]) return true;
    const cursor = this.cursorByBuffer[this.altBuffer];
    const column = Math.min(cursor.column, this.columns - 1);
    return continuation.firstPrintedRow < cursor.row
      || (continuation.firstPrintedRow === cursor.row
        && continuation.firstPrintedColumn <= column);
  }

  private dispatchCursorCsi(final: string): void {
    if (!this.cursorReliableByBuffer[this.altBuffer] && POSITIONING_CSI_FINALS.has(final)) {
      this.contentInvalidated = true;
    }
    const cursor = this.cursorByBuffer[this.altBuffer];
    switch (final) {
      case '@':
      case 'P':
      case 'X':
        if (this.characterEditTouchesContinuation(final)) this.contentInvalidated = true;
        this.assignCursor(Math.min(cursor.column, this.columns - 1), cursor.row);
        break;
      case 'A': this.moveCursorToVerticalMargin(this.csiParam(), -1); break;
      case 'B': this.moveCursorToVerticalMargin(this.csiParam(), 1); break;
      case 'C':
      case 'a': this.moveCursor(this.csiParam(), 0); break;
      case 'D': this.moveCursor(-this.csiParam(), 0); break;
      case 'E':
        this.moveCursorToVerticalMargin(this.csiParam(), 1);
        this.assignCursor(0, cursor.row);
        break;
      case 'F':
        this.moveCursorToVerticalMargin(this.csiParam(), -1);
        this.assignCursor(0, cursor.row);
        break;
      case 'G':
      case '`': this.assignCursor(this.csiParam() - 1, cursor.row); break;
      case 'H':
      case 'f': this.setAbsoluteCursor(this.csiParam(1) - 1, this.csiParam(0) - 1); break;
      case 'I': this.moveToTab(1, this.csiParam()); break;
      case 'J':
      case 'K': {
        const mode = this.csiParamValues[0] ?? 0;
        const touches = final === 'K'
          ? this.eraseLineTouchesContinuation(mode)
          : mode === 2
            || (mode === 0 && this.eraseDisplayToEndTouchesContinuation())
            || (mode === 1 && this.eraseDisplayToStartTouchesContinuation())
            || (mode === 3
              && this.continuation?.buffer === this.altBuffer
              && this.continuation.printedInScrollback);
        if (touches) {
          this.contentInvalidated = true;
        }
        break;
      }
      case 'L':
      case 'M': {
        const region = this.activeScrollRegion();
        this.assignCursor(Math.min(cursor.column, this.columns - 1), cursor.row);
        if (cursor.row >= region.top && cursor.row <= region.bottom) {
          if (this.lineEditTouchesContinuation()) this.contentInvalidated = true;
          this.assignCursor(0, cursor.row);
        }
        break;
      }
      case 'S':
      case 'T':
        this.contentInvalidated = true;
        break;
      case 'Z': this.moveToTab(-1, this.csiParam()); break;
      case 'b': this.moveCursor(this.csiParam(), 0); break;
      case 'd':
        this.assignCursor(
          cursor.column,
          this.csiParam() - 1 + (this.originMode ? this.activeScrollRegion().top : 0),
        );
        break;
      case 'e': this.moveCursor(0, this.csiParam()); break;
      case 'g':
        if (this.csiParamValues[0] === 0 || this.csiParamValues[0] === 3) this.invalidateTabStops();
        break;
      case 'r': this.setScrollRegion(); break;
      default: break;
    }
  }

  private emitPrint(text: string, widthReliable = true): string {
    this.carriageReturnContinuation = undefined;
    const cursor = this.cursorByBuffer[this.altBuffer];
    const reliable = this.cursorReliableByBuffer[this.altBuffer];
    const consumesPendingWrap = reliable && cursor.column >= this.columns && this.wraparound;
    if (reliable && cursor.column >= this.columns) {
      if (this.wraparound) {
        cursor.column = 0;
        this.indexCursor(false);
      } else {
        cursor.column = this.columns - 1;
      }
    }
    const printedRow = cursor.row;
    const printedColumn = cursor.column;
    const previous = this.continuation;
    const continuous = this.continuation === undefined
      || (
        this.continuation.buffer === this.altBuffer
        && this.continuation.reliable === reliable
        && (!this.continuation.wrapPending || consumesPendingWrap)
        && (
          (this.continuation.row === cursor.row && this.continuation.column === cursor.column)
          || (cursor.row === this.continuation.row + 1 && cursor.column === 0)
        )
      );
    const boundary = this.contentInvalidated || !continuous ? REMAPPED : '';
    this.contentInvalidated = false;
    this.printSequenceByBuffer[this.altBuffer]++;
    const nextColumn = cursor.column + 1;
    if (reliable) {
      cursor.column = this.wraparound ? nextColumn : Math.min(nextColumn, this.columns - 1);
    } else {
      cursor.column = Math.min(nextColumn, MAX_CSI_PARAM);
    }
    const nextReliable = reliable && widthReliable;
    this.cursorReliableByBuffer[this.altBuffer] = nextReliable;
    const region = this.activeScrollRegion();
    const wraps = nextReliable && this.wraparound && nextColumn === this.columns;
    const nextRow = wraps
      ? cursor.row === region.bottom || cursor.row === this.rows - 1
        ? cursor.row
        : cursor.row + 1
      : cursor.row;
    this.continuation = {
      buffer: this.altBuffer,
      firstPrintedColumn: boundary === '' && previous?.buffer === this.altBuffer
        ? previous.firstPrintedColumn
        : printedColumn,
      firstPrintedRow: boundary === '' && previous?.buffer === this.altBuffer
        ? previous.firstPrintedRow
        : printedRow,
      lastPrintedColumn: printedColumn,
      lastPrintedRow: printedRow,
      printedInScrollback: boundary === '' && previous?.buffer === this.altBuffer
        ? previous.printedInScrollback
        : false,
      row: nextRow,
      column: wraps ? 0 : nextColumn,
      reliable: nextReliable,
      wrapPending: wraps && nextRow === cursor.row,
    };
    return boundary + text;
  }

  private acceptCursorMovement(): void {
    if (this.continuation?.buffer !== this.altBuffer) return;
    const cursor = this.cursorByBuffer[this.altBuffer];
    this.continuation = {
      ...this.continuation,
      row: cursor.row,
      column: cursor.column,
      reliable: this.cursorReliableByBuffer[this.altBuffer],
      wrapPending: false,
    };
  }

  private cursorIsAtContinuation(): boolean {
    const continuation = this.continuation;
    const cursor = this.cursorByBuffer[this.altBuffer];
    return continuation?.buffer === this.altBuffer
      && continuation.reliable === this.cursorReliableByBuffer[this.altBuffer]
      && continuation.row === cursor.row
      && continuation.column === cursor.column;
  }

  private canAcceptVerticalMovement(): boolean {
    if (this.cursorIsAtContinuation()) return true;
    const continuation = this.continuation;
    const cursor = this.cursorByBuffer[this.altBuffer];
    return continuation !== undefined
      && continuation === this.carriageReturnContinuation
      && continuation.buffer === this.altBuffer
      && continuation.reliable === this.cursorReliableByBuffer[this.altBuffer]
      && continuation.row === cursor.row
      && cursor.column === 0;
  }

  private executeCursorC0(code: number, acceptMovement: boolean): void {
    const cursor = this.cursorByBuffer[this.altBuffer];
    let moved = true;
    let acceptsVerticalMovement = true;
    if (code === 0x08) this.moveCursor(-1, 0);
    else if (code === 0x09) this.moveToTab(1, 1);
    else if (code === 0x0a || code === 0x0b || code === 0x0c) {
      acceptsVerticalMovement = this.canAcceptVerticalMovement();
      moved = this.indexCursor(true);
      this.carriageReturnContinuation = undefined;
    } else if (code === 0x0d) {
      this.carriageReturnContinuation = this.cursorIsAtContinuation()
        ? this.continuation
        : undefined;
      this.assignCursor(0, cursor.row);
    }
    if (acceptMovement && moved && acceptsVerticalMovement) this.acceptCursorMovement();
  }

  private dispatchCsi(final: string): string {
    this.flushCsiParam();
    if (!this.csiOverflowed) {
      if (this.csiPrefix === '?' && this.csiIntermediates === '') {
        if (final === 'J' || final === 'K') this.dispatchCursorCsi(final);
        else this.dispatchPrivateMode(final);
      } else if (this.csiPrefix === '' && this.csiIntermediates === '' && final === 's') {
        this.saveCursorState();
      } else if (this.csiPrefix === '' && this.csiIntermediates === '' && final === 'u') {
        this.restoreCursorState();
      } else if (this.csiPrefix === '' && this.csiIntermediates === '' && final === SGR_FINAL) {
        this.dispatchSgr();
      } else if (this.csiPrefix === '' && this.csiIntermediates === '') {
        this.dispatchCursorCsi(final);
      } else if (this.csiPrefix === ''
        && this.csiIntermediates === "'"
        && (final === '}' || final === '~')) {
        if (this.columnEditTouchesContinuation()) this.contentInvalidated = true;
      } else if (this.csiPrefix === '' && this.csiIntermediates === '!' && final === 'p') {
        this.softReset();
      } else if (this.csiPrefix === '' && this.csiIntermediates === ' ' && (final === '@' || final === 'A')) {
        this.contentInvalidated = true;
      }
    }
    const transparent = this.csiPrefix === '' && this.csiIntermediates === '' && final === SGR_FINAL;
    const boundary = this.csiEightBit && !transparent ? REMAPPED : '';
    this.clearCsiCollect();
    this.state = S.ground;
    return boundary;
  }

  private activateAltBuffer(): void {
    if (this.altBuffer === 1) return;
    const saved = this.savedByBuffer[1];
    if (saved !== undefined) {
      this.savedByBuffer[1] = { ...saved, continuation: undefined };
    }
    if (this.continuation?.buffer === 1) {
      this.continuation = undefined;
      this.contentInvalidatedByBuffer[1] = true;
    } else {
      this.contentInvalidatedByBuffer[1] = false;
    }
    const cursor = this.cursorByBuffer[0];
    this.altBuffer = 1;
    this.cursorByBuffer[1] = { ...cursor };
    this.cursorReliableByBuffer[1] = this.cursorReliableByBuffer[0];
    this.tabStopsReliableByBuffer[1] = true;
    this.scrollRegionByBuffer[1] = this.fullScrollRegion();
  }

  private activateMainBuffer(): void {
    if (this.altBuffer === 0) return;
    const cursor = this.cursorByBuffer[1];
    const cursorReliable = this.cursorReliableByBuffer[1];
    this.altBuffer = 0;
    this.cursorByBuffer[0] = { ...cursor };
    this.cursorReliableByBuffer[0] = cursorReliable;
    this.contentInvalidatedByBuffer[1] = false;
    this.cursorByBuffer[1] = { row: 0, column: 0 };
    this.cursorReliableByBuffer[1] = true;
    this.tabStopsReliableByBuffer[1] = true;
    this.scrollRegionByBuffer[1] = this.fullScrollRegion();
  }

  private dispatchPrivateMode(final: string): void {
    if (final !== 'h' && final !== 'l') return;
    const set = final === 'h';
    for (const param of this.csiParamValues) {
      if (param === 1048) {
        if (set) this.saveCursorState(); else this.restoreCursorState();
      } else if (param === 1049) {
        if (set) {
          this.saveCursorState();
          this.activateAltBuffer();
        } else {
          this.activateMainBuffer();
          this.restoreCursorState();
        }
      } else if (param === 47 || param === 1047) {
        if (set) this.activateAltBuffer(); else this.activateMainBuffer();
      } else if (param === 6) {
        if (!this.cursorReliableByBuffer[this.altBuffer]) this.contentInvalidated = true;
        this.originMode = set;
        this.setAbsoluteCursor(0, 0);
      } else if (param === 7) {
        this.wraparound = set;
      } else if (param === 2 && set) {
        this.resetCharsetSlots();
      }
    }
  }

  private remapsCode(code: number): boolean {
    return this.active !== undefined && (REMAPPED_CODES.get(this.active)?.has(code) ?? false);
  }

  write(rawChunk: string): string {
    const chunk = this.pendingHigh + rawChunk;
    this.pendingHigh = '';
    let out = '';
    for (let i = 0; i < chunk.length; i++) {
      let code = chunk.charCodeAt(i);
      let width = 1;
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 === chunk.length) {
          this.pendingHigh = chunk[i];
          break;
        }
        if ((chunk.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
          code = 0x10000;
          width = 2;
        }
      }
      if (code === 0xfeff) continue;
      if (code >= 0xa0) {
        if (this.state === S.ground) {
          out += this.emitPrint(this.conceal ? REMAPPED : chunk.slice(i, i + width), false);
        }
        else if (!NON_ASCII_IGNORED.has(this.state)) { this.pendingIntermediate = undefined; this.state = S.ground; }
        i += width - 1;
        continue;
      }
      if (CURSOR_MOVING_C0.has(code)) {
        if (EXECUTES_C0.has(this.state)) {
          out += code === 0x0d && this.state !== S.ground ? REMAPPED : chunk[i];
          this.executeCursorC0(code, code !== 0x0d && code !== 0x09);
        }
        continue;
      }
      if ((code === 0x0b || code === 0x0c) && EXECUTES_C0.has(this.state)) {
        this.executeCursorC0(code, true);
        continue;
      }
      if (code === 0x0e || code === 0x0f) {
        if (EXECUTES_C0.has(this.state)) this.setgLevel(code === 0x0e ? 1 : 0);
        continue;
      }
      if (code === 0x88) {
        this.invalidateTabStops();
        this.pendingIntermediate = undefined;
        this.state = S.ground;
        continue;
      }
      const jump = anywhereTransition(code);
      if (jump !== undefined) {
        this.pendingIntermediate = undefined;
        if (jump === S.csiEntry) { this.clearCsiCollect(); this.csiEightBit = true; }
        this.state = jump;
        continue;
      }
      switch (this.state) {
        case S.ground:
          if (code >= 0x20 && code <= 0x7e) {
            out += this.emitPrint(this.conceal || this.remapsCode(code) ? REMAPPED : chunk[i]);
          }
          break;
        case S.escape:
          if (code <= 0x1f || code === 0x7f) break;
          if (code <= 0x2f) {
            this.pendingIntermediate = chunk[i];
            this.state = S.escapeIntermediate;
          }
          else if (code === 0x50) this.state = S.dcsEntry;
          else if (code === 0x58 || code === 0x5e || code === 0x5f) this.state = S.sosPmApcString;
          else if (code === 0x5b) { this.clearCsiCollect(); this.csiEightBit = false; this.state = S.csiEntry; }
          else if (code === 0x5d) this.state = S.oscString;
          else {
            const shifted = LOCKING_SHIFTS[chunk[i]];
            if (shifted !== undefined) this.setgLevel(shifted);
            else if (code === 0x37) this.saveCursorState();
            else if (code === 0x38) this.restoreCursorState();
            else if (code === 0x63) { this.fullReset(); out += REMAPPED; }
            else if (code === 0x44) {
              const acceptsMovement = this.canAcceptVerticalMovement();
              const moved = this.indexCursor(true);
              this.carriageReturnContinuation = undefined;
              if (moved && acceptsMovement) this.acceptCursorMovement();
            }
            else if (code === 0x45) {
              const cursor = this.cursorByBuffer[this.altBuffer];
              const acceptsMovement = this.canAcceptVerticalMovement();
              const moved = this.indexCursor(true);
              this.assignCursor(0, cursor.row);
              this.carriageReturnContinuation = undefined;
              if (moved && acceptsMovement) this.acceptCursorMovement();
            } else if (code === 0x4d) {
              this.moveCursor(0, -1);
              out += REMAPPED;
              this.continuation = undefined;
            } else if (code === 0x48) this.invalidateTabStops();
            this.state = S.ground;
          }
          break;
        case S.escapeIntermediate:
          if (code >= 0x30 && code <= 0x7e) {
            const intermediate = this.pendingIntermediate;
            this.pendingIntermediate = undefined;
            const slot = intermediate === undefined ? undefined : DESIGNATE_INTERMEDIATES[intermediate];
            if (slot !== undefined) {
              if (RECOGNISED_DESIGNATORS.has(chunk[i])) this.setgCharset(slot, chunk[i]);
            } else if (intermediate === '%' && (code === 0x47 || code === 0x40)) {
              this.selectDefaultCharset();
            }
            else if (intermediate === '#' && code === 0x38) out += REMAPPED;
            this.state = S.ground;
          } else if (code >= 0x20 && code <= 0x2f) {
            this.pendingIntermediate = undefined;
          }
          break;
        case S.csiEntry:
          if (code >= 0x40 && code <= 0x7e) out += this.dispatchCsi(chunk[i]);
          else if (code >= 0x30 && code <= 0x3f) {
            if (code >= 0x3c) this.collectCsiPrefix(chunk[i]);
            else this.collectCsiParam(chunk[i]);
            this.state = S.csiParam;
          } else if (code >= 0x20 && code <= 0x2f) {
            this.collectCsiIntermediate(chunk[i]);
            this.state = S.csiIntermediate;
          }
          break;
        case S.csiParam:
          if (code >= 0x40 && code <= 0x7e) out += this.dispatchCsi(chunk[i]);
          else if (code >= 0x3c && code <= 0x3f) this.state = S.csiIgnore;
          else if (code >= 0x20 && code <= 0x2f) {
            this.collectCsiIntermediate(chunk[i]);
            this.state = S.csiIntermediate;
          } else if (code >= 0x30 && code <= 0x3b) this.collectCsiParam(chunk[i]);
          break;
        case S.csiIntermediate:
          if (code >= 0x40 && code <= 0x7e) out += this.dispatchCsi(chunk[i]);
          else if (code >= 0x30 && code <= 0x3f) this.state = S.csiIgnore;
          else if (code >= 0x20 && code <= 0x2f) this.collectCsiIntermediate(chunk[i]);
          break;
        case S.csiIgnore:
          if (code >= 0x40 && code <= 0x7e) this.state = S.ground;
          break;
        case S.dcsEntry:
          if (code >= 0x40 && code <= 0x7e) this.state = S.dcsPassthrough;
          else if (code >= 0x30 && code <= 0x3f) this.state = S.dcsParam;
          else if (code >= 0x20 && code <= 0x2f) this.state = S.dcsIntermediate;
          break;
        case S.dcsParam:
          if (code >= 0x40 && code <= 0x7e) this.state = S.dcsPassthrough;
          else if (code >= 0x3c && code <= 0x3f) this.state = S.dcsIgnore;
          else if (code >= 0x20 && code <= 0x2f) this.state = S.dcsIntermediate;
          break;
        case S.dcsIntermediate:
          if (code >= 0x40 && code <= 0x7e) this.state = S.dcsPassthrough;
          else if (code >= 0x30 && code <= 0x3f) this.state = S.dcsIgnore;
          break;
        case S.oscString:
          if (code === 0x07) this.state = S.ground;
          break;
        default:
          break;
      }
    }
    return out;
  }
}

export function visibleText(text: string, columns = DEFAULT_COLUMNS, rows = DEFAULT_ROWS): string {
  return new VisibleTextExtractor(columns, rows).write(text);
}
