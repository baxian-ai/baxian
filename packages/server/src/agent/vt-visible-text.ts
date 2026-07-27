// 转移表按 https://vt100.net/emu/dec_ansi_parser

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

// 这几个状态显式忽略 xterm 的 NON_ASCII_PRINTABLE 槽；其余状态无表项，走 ERROR 打回 ground。
const NON_ASCII_IGNORED: ReadonlySet<State> = new Set([
  S.oscString, S.dcsPassthrough, S.csiIgnore, S.dcsIgnore,
]);

// 转移动作为 EXECUTE 的状态；Dcs*/Osc/SosPmApc 里是 ignore/put，屏幕无效果。
const EXECUTES_C0: ReadonlySet<State> = new Set([
  S.ground, S.escape, S.escapeIntermediate,
  S.csiEntry, S.csiParam, S.csiIntermediate, S.csiIgnore,
]);

// 保留原字节：属不属 \s 正好就编码了会不会隔断 marker——BS 隔断，HT/LF/CR 让软换行接得回去。
const CURSOR_MOVING_C0 = new Set([0x08, 0x09, 0x0a, 0x0d]);

// 被字符集改写的字节在屏幕上是别的字形，拼出来的 marker 终端根本不显示。既不能原样吐也不能丢
// ——两者都会拼出 marker——所以吐一个 compact 删不掉、又不可能出现在 marker 里的分隔符。
const REMAPPED = '\x00';

// 必须精确到字节：UK('A') 只改 '#'，把整套字符集判为不可见会漏掉屏幕上真实可见的 marker。
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

// 只有终端认得的 designator 才会改写槽位；认不出的整条 designation 被忽略、旧字符集留任。
const RECOGNISED_DESIGNATORS: ReadonlySet<string> = new Set([...Object.keys(CHARSET_REMAPS), 'B']);

const MAX_CSI_PARAMS = 32;
const MAX_CSI_PARAM = 0x7fffffff;

type Slot = 0 | 1 | 2 | 3;
interface CursorState { charset: string | undefined; conceal: boolean }
const SGR_FINAL = 'm';
// GR 的 '-' '.' 与 GL 的 ')' '*' 落在同一批槽位上，后续 SO/LS2 会把它们选出来；'/' 被忽略。
const DESIGNATE_INTERMEDIATES: Readonly<Record<string, Slot>> = {
  '(': 0, ')': 1, '*': 2, '+': 3, '-': 1, '.': 2,
};
// xterm 5.5.0 把 LS1R/LS2R/LS3R 也当作 GL 移位处理，与标准的 GR 语义不同。
const LOCKING_SHIFTS: Readonly<Record<string, Slot>> = { n: 2, o: 3, '|': 3, '}': 2, '~': 1 };

// ESC、CAN/SUB 与全部 C1 控制取消进行中的序列，从任何状态生效。
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
  // 装载的那张表与槽位是两样东西：DECSC/DECRC 只存取 active，移位则从 charsets 重新装载。
  private active: string | undefined;
  private readonly charsets: Array<string | undefined> = [undefined, undefined, undefined, undefined];
  private gl: Slot = 0;
  // 每个缓冲区各存一份（`CSI ?1049h` 进备用屏时存的是主屏那份）；
  // 存了 undefined 与没存过是两回事，故用外层 undefined 表示"没存过"。
  private savedByBuffer: Array<CursorState | undefined> = [undefined, undefined];
  private conceal = false;
  private altBuffer = 0;
  private pendingIntermediate: string | undefined;
  // 私有前缀要留原字节：只有 '?' 是 DEC private mode，'<' '=' '>' 各有别的含义。
  private csiPrefix = '';
  private csiIntermediates = '';
  // 按 xterm 的 Params 语义收数值主参数：前导零归一、冒号子参数只取冒号前的值、
  // 容量算的是**参数个数**（超出的丢弃，已收下的照常派发），不是原始字符数。
  private csiParamValues: number[] = [];
  private csiParamHasSub: boolean[] = [];
  private csiParamValue = 0;
  private csiParamStarted = false;
  private csiInSubParam = false;
  private csiOverflowed = false;
  private csiEightBit = false;

  reset(): void {
    this.state = S.ground;
    this.pendingHigh = '';
    this.fullReset();
    this.altBuffer = 0;
    this.pendingIntermediate = undefined;
    this.clearCsiCollect();
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

  // `CSI ?2h` 只重指定 G0-G3，不碰 GL，也不碰已保存的那份。
  private resetCharsetSlots(): void {
    this.charsets.fill(undefined);
    this.active = undefined;
  }

  // DECSTR 连 GL 与**当前 buffer** 保存的那份一起清；另一个 buffer 的存档不归它管。
  private softReset(): void {
    this.resetCharsetSlots();
    this.gl = 0;
    this.conceal = false;
    this.savedByBuffer[this.altBuffer] = undefined;
  }

  // RIS 是整机复位：连 buffer 身份与两份存档一起回到初始。
  private fullReset(): void {
    this.resetCharsetSlots();
    this.gl = 0;
    this.conceal = false;
    this.savedByBuffer = [undefined, undefined];
    this.altBuffer = 0;
  }

  // ESC % G/@ 只是"选回默认"：动 G0 与 GL，不碰 G1-G3。
  private selectDefaultCharset(): void {
    this.setgCharset(0, undefined);
    this.setgLevel(0);
  }

  private saveCursorState(): void {
    this.savedByBuffer[this.altBuffer] = { charset: this.active, conceal: this.conceal };
  }

  private restoreCursorState(): void {
    const saved = this.savedByBuffer[this.altBuffer];
    this.active = saved?.charset;
    this.conceal = saved?.conceal ?? false;
  }

  // SGR 8 让字形在屏幕上消失，单元格里却还留着字符——和字符集重映射是同一类问题。
  private dispatchSgr(): void {
    for (let i = 0; i < this.csiParamValues.length; i++) {
      const param = this.csiParamValues[i];
      if (param === 38 || param === 48 || param === 58) {
        i += this.extendedColourSpan(i);
      } else if (param === 8) this.conceal = true;
      else if (param === 0 || param === 28) this.conceal = false;
    }
  }

  // 照搬 xterm 的 _extractColor 推进量：颜色载荷里的 8/28 是分量值，当成独立参数两个方向都会错。
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

  private dispatchCsi(final: string): string {
    this.flushCsiParam();
    if (this.csiOverflowed) {
      // fall through to the reset below
    } else if (this.csiPrefix === '?') {
      if (this.csiIntermediates === '') this.dispatchPrivateMode(final);
    } else if (this.csiPrefix === '' && this.csiIntermediates === '' && final === 's') {
      this.saveCursorState();
    } else if (this.csiPrefix === '' && this.csiIntermediates === '' && final === 'u') {
      this.restoreCursorState();
    } else if (this.csiPrefix === '' && this.csiIntermediates === '' && final === SGR_FINAL) {
      this.dispatchSgr();
    } else if (this.csiPrefix === '' && this.csiIntermediates === '!' && final === 'p') {
      this.softReset(); // DECSTR
    }
    // 派发出去的 8-bit CSI 真会动屏幕，而 main 的正则不认 0x9b、天然隔开 marker——只有 SGR 例外，
    // 它唯一的可见性影响（conceal）已经建模。取消/ignore 的序列 xterm 整条丢弃，不在此列。
    const transparent = this.csiPrefix === '' && this.csiIntermediates === '' && final === SGR_FINAL;
    const boundary = this.csiEightBit && !transparent ? REMAPPED : '';
    this.clearCsiCollect();
    this.state = S.ground;
    return boundary;
  }

  private dispatchPrivateMode(final: string): void {
    if (final !== 'h' && final !== 'l') return;
    const set = final === 'h';
    for (const param of this.csiParamValues) {
      // 保存/恢复与切屏是两件事：1048 只在当前 buffer 存取游标字符集、不切屏；
      // 47/1047 只切屏、不存取；1049 两件都做。
      if (param === 1048) {
        if (set) this.saveCursorState(); else this.restoreCursorState();
      } else if (param === 1049) {
        if (set) { this.saveCursorState(); this.altBuffer = 1; }
        else { this.altBuffer = 0; this.restoreCursorState(); }
      } else if (param === 47 || param === 1047) {
        this.altBuffer = set ? 1 : 0;
      } else if (param === 2 && set) {
        this.resetCharsetSlots();
      }
    }
  }

  private remapsCode(code: number): boolean {
    return this.active !== undefined && (REMAPPED_CODES.get(this.active)?.has(code) ?? false);
  }

  write(rawChunk: string): string {
    // 按码点解析：跨 write 拆开的代理对要缝回去，否则低代理会落在与高代理不同的状态里。
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
      if (code === 0xfeff) continue; // xterm 的 StringToUtf32 在喂进转移表前就丢掉 BOM
      if (code >= 0xa0) {
        if (this.state === S.ground) out += this.conceal ? REMAPPED : chunk.slice(i, i + width);
        else if (!NON_ASCII_IGNORED.has(this.state)) { this.pendingIntermediate = undefined; this.state = S.ground; }
        i += width - 1;
        continue;
      }
      if (CURSOR_MOVING_C0.has(code)) {
        // 序列里的 CR 不是软换行的一半，而是真把后半段重画到行首。
        if (EXECUTES_C0.has(this.state)) out += code === 0x0d && this.state !== S.ground ? REMAPPED : chunk[i];
        continue; // EXECUTE 与 ignore 都保持当前状态
      }
      if (code === 0x0e || code === 0x0f) {
        if (EXECUTES_C0.has(this.state)) this.setgLevel(code === 0x0e ? 1 : 0);
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
            out += this.conceal || this.remapsCode(code) ? REMAPPED : chunk[i];
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
            else if (code === 0x63) { this.fullReset(); out += REMAPPED; } // RIS wipes the screen
            else if (code === 0x4d) out += REMAPPED; // RI 把后半段挪到前半段上一行
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
              this.selectDefaultCharset(); // only ESC % G / ESC % @; other finals are ignored
            }
            else if (intermediate === '#' && code === 0x38) out += REMAPPED; // DECALN wipes the screen
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
          break; // 剩下的 C0/DEL 在参数态是 execute/ignore，不能当数字累进参数
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
          if (code === 0x07) this.state = S.ground; // BEL 只终结 OSC，其余控制串忽略它
          break;
        default:
          break;
      }
    }
    return out;
  }
}

export function visibleText(text: string): string {
  return new VisibleTextExtractor().write(text);
}
