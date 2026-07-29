import { describe, expect, it } from 'vitest';
import xterm from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { VisibleTextExtractor, visibleText } from '../../src/agent/vt-visible-text.js';
import { compactSignalText } from '../../src/agent/phase-signal.js';

const ESC = '\x1b';
const BEL = '\x07';
const ST = '\x9c';
const BOM = '﻿';
const HI = '\ud83d';
const LO = '\ude00';
const MARKER = '[bx:pr-fixed:tok123abc]';

interface PrintProbe {
  feed: (data: string) => Promise<void>;
  take: () => string;
  dispose: () => void;
}

function printProbe(): PrintProbe {
  const term = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 200, allowProposedApi: true });
  const parser = (term as unknown as {
    _core: { _inputHandler: { _parser: { setPrintHandler: (cb: (d: Uint32Array, s: number, e: number) => void) => void } } };
  })._core._inputHandler._parser;
  expect(typeof parser.setPrintHandler).toBe('function');
  let printed = '';
  parser.setPrintHandler((data, start, end) => {
    for (let i = start; i < end; i++) printed += String.fromCodePoint(data[i]);
  });
  return {
    feed: (data) => new Promise<void>(resolve => term.write(data, () => resolve())),
    take: () => { const out = printed; printed = ''; return out; },
    dispose: () => term.dispose(),
  };
}

async function renderScreen(input: string): Promise<string> {
  const term = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 200, allowProposedApi: true });
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  await new Promise<void>(resolve => term.write(input, () => resolve()));
  const out = serialize.serialize().replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '');
  term.dispose();
  return out;
}

const NON_PRINT_WE_ADD = /[\x00-\x1f\x7f-\x9f]/g;

async function wideRow0(input: string): Promise<string> {
  const term = new xterm.Terminal({ cols: 250, rows: 4, allowProposedApi: true });
  await new Promise<void>(resolve => term.write(input, () => resolve()));
  const out = term.buffer.active.getLine(0)?.translateToString(false) ?? '';
  term.dispose();
  return out;
}

async function screenText(input: string): Promise<string> {
  const term = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 200, allowProposedApi: true });
  await new Promise<void>(resolve => term.write(input, () => resolve()));
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let i = 0; i < buffer.length; i++) rows.push(buffer.getLine(i)?.translateToString(true) ?? '');
  term.dispose();
  return rows.join('\n');
}

async function withoutParserNoise<T>(run: () => Promise<T>): Promise<T> {
  const consoleError = console.error;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    console.error = consoleError;
  }
}

async function screenHides(prefix: string): Promise<boolean> {
  const term = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  await new Promise<void>(resolve => term.write(`${prefix}X`, () => resolve()));
  const buffer = term.buffer.active;
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (cell?.getChars() === 'X') {
        term.dispose();
        return cell.isInvisible() !== 0;
      }
    }
  }
  term.dispose();
  return true;
}

describe('VisibleTextExtractor vs the terminal parser', () => {
  it('agrees with xterm on 2000 random control-sequence streams, whatever the chunking', async () => {
    const atoms = [
      ESC, `${ESC}[`, `${ESC}]`, `${ESC}_`, `${ESC}^`, `${ESC}X`, `${ESC}P`, `${ESC}\\`,
      `${ESC}[0m`, `${ESC}[31;1m`, `${ESC}]0;`, `${ESC}]8;;https://x${BEL}`, BEL,
      '\x9b', '\x9d', ST, '\x90', '\x98', '\x9e', '\x9f',
      '\x18', '\x1a', '\x7f', '\x00', '\x08', '\x0b', '\x0c', '\x1c', '\x1f',
      `${ESC}(B`, `${ESC}#8`, `${ESC} P`, `${ESC}P1$r`, `${ESC}[?25l`, `${ESC}[38;2;1;2;3m`,
      `${ESC}[ q`, `${ESC}[<0;1;2M`, `${ESC}[?`, `${ESC}[1?`, `${ESC}[<`, `${ESC}[1;2<`,
      `${ESC}[1 `, `${ESC}P1<`, `${ESC}P;`, `${ESC}P /`, `${ESC}[:`, `${ESC}[1:`,
      `${ESC}[999999999999m`, `${ESC}[:::m`, `${ESC}[${';'.repeat(40)}m`,
      'A', 'z', '0', ' ', '\n', '\r', '\t', '[bx:', 'pr-fixed', ':tok123abc', ']',
      '中', '\u{1f600}', '\xe9', '\xa0', '\xff', BOM, `A${BOM}B`, '​', `${BOM}\u{1f600}`,
      '\x85', '\x84', '\x88', '\x8d', '\x91', '\x97', '\x99', '\x9a', '\x80',
    ];
    let seed = 0x2f6e2b1;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    const probe = printProbe();
    const extractor = new VisibleTextExtractor();
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      for (let round = 0; round < 2000; round++) {
        let stream = '';
        const atomCount = 1 + Math.floor(rnd() * 20);
        for (let i = 0; i < atomCount; i++) stream += atoms[Math.floor(rnd() * atoms.length)];
        await probe.feed(stream);
        let ours = '';
        for (let i = 0; i < stream.length;) {
          const size = 1 + Math.floor(rnd() * 5);
          ours += extractor.write(stream.slice(i, i + size));
          i += size;
        }
        expect(ours.replace(NON_PRINT_WE_ADD, ''), `round ${round}: ${JSON.stringify(stream)}`)
          .toBe(probe.take());
      }
    } finally {
      console.error = consoleError;
      probe.dispose();
    }
  }, 15_000);

  it('never sees xterm PRINT a C0/C1, which is what makes the projection lossless', async () => withoutParserNoise(async () => {
      const prefixes = ['', ESC, `${ESC} `, `${ESC}[`, `${ESC}[12`, `${ESC}]0;x`,
        `${ESC}P`, `${ESC}P1$rx`, `${ESC}_x`, `${ESC}^x`, `${ESC}Xx`];
      for (const prefix of prefixes) {
        for (let code = 0; code <= 0x9f; code++) {
          const probe = printProbe();
          await probe.feed(prefix + String.fromCharCode(code));
          expect(probe.take()).not.toMatch(NON_PRINT_WE_ADD);
          probe.dispose();
        }
      }
  }), 15_000);
});

describe('output contract: HT/LF/CR follow the EXECUTE action', () => {
  const EXECUTE_PREFIXES: Array<[string, string, string]> = [
    ['ground', '', ''],
    ['escape', ESC, 'Z'],
    ['escape-intermediate', `${ESC} `, 'Z'],
    ['csi-entry', `${ESC}[`, '31m'],
    ['csi-param', `${ESC}[3`, '1m'],
    ['csi-intermediate', `${ESC}[1 `, 'q'],
    ['csi-ignore', `${ESC}[1<`, 'm'],
  ];
  const IGNORE_PREFIXES: Array<[string, string, string]> = [
    ['dcs-entry', `${ESC}P`, `${ESC}\\`],
    ['dcs-param', `${ESC}P1`, `${ESC}\\`],
    ['dcs-ignore', `${ESC}P1<`, `${ESC}\\`],
    ['dcs-passthrough', `${ESC}P1$r`, `${ESC}\\`],
    ['osc', `${ESC}]0;`, BEL],
    ['sos-pm-apc', `${ESC}_`, `${ESC}\\`],
  ];

  it.each(EXECUTE_PREFIXES)('emits LF in %s, where the cursor really moves', async (_name, prefix, suffix) => {
    const stream = `A${prefix}\n${suffix}B`;
    expect(visibleText(stream)).toBe('A\nB');
    expect(await renderScreen(stream)).toContain('\r\n');
  });

  it.each(IGNORE_PREFIXES)('swallows LF in %s, where the terminal shows nothing', async (_name, prefix, suffix) => {
    const stream = `A${prefix}\n${suffix}B`;
    expect(visibleText(stream)).toBe('AB');
    expect(await renderScreen(stream)).not.toContain('\r\n');
  });

  it('pins the contract on ESC [ LF 31m B: xterm prints AB, the screen wraps, we keep the LF', async () => {
    const stream = `A${ESC}[\n31mB`;
    const probe = printProbe();
    await probe.feed(stream);
    const printed = probe.take();
    probe.dispose();
    const screen = await renderScreen(stream);

    const ours = visibleText(stream);
    expect(printed).toBe('AB');
    expect(screen).toContain('\r\n');
    expect(ours).toBe('A\nB');
    expect(ours.replace(NON_PRINT_WE_ADD, '')).toBe(printed);
  });

  it('keeps the cursor-moving C0 verbatim and drops every other one', () => {
    expect(visibleText('\tA\nB\rC')).toBe('\tA\nB\r\x00C');
    expect(visibleText('A\x08B')).toBe('A\x08B');
    expect(visibleText('\x00\x0b\x0c\x1fA')).toBe('A');
  });
});

describe('input decoding layer', () => {
  it('drops U+FEFF wherever it appears, including split across writes', () => {
    expect(visibleText(`A${BOM}B`)).toBe('AB');
    expect(visibleText(`${BOM}A`)).toBe('A');
    expect(visibleText(`A${BOM}${BOM}B`)).toBe('AB');
    const extractor = new VisibleTextExtractor();
    expect(extractor.write('A') + extractor.write(BOM) + extractor.write('B')).toBe('AB');
  });

  it('drops U+FEFF inside control strings too (nothing surfaces either way)', () => {
    expect(visibleText(`${ESC}]0;${BOM}${BEL}B`)).toBe('B');
    expect(visibleText(`A${ESC}[3${BOM}1mB`)).toBe('AB');
  });

  it('keeps other zero-width and no-break characters — only the BOM is special', () => {
    expect(visibleText('A​B')).toBe('A​B');
    expect(visibleText('A\xa0B')).toBe('A\xa0B');
  });

  it('treats a surrogate pair as one code point, even when the chunk splits it', () => {
    const extractor = new VisibleTextExtractor();
    expect(extractor.write(`A${HI}`) + extractor.write(`${LO}B`)).toBe('A\u{1f600}B');
  });

  it('a non-ASCII code point aborts a pending sequence exactly once, not once per unit', () => {
    expect(visibleText(`${ESC}[1\u{1f600}B`)).toBe('B');
  });

  it('holds a trailing high surrogate for the next write instead of emitting it', () => {
    const extractor = new VisibleTextExtractor();
    expect(extractor.write(`A${HI}`)).toBe('A');
    expect(extractor.write(`${LO}`)).toBe('\u{1f600}');
  });
});

describe('known, deliberate divergence from xterm 5.5.0', () => {
  it('drops a BOM that xterm keeps after a stranded high surrogate — invisible to detection', async () => {
    const stream = `A${HI}${BOM}B`;
    const probe = printProbe();
    await probe.feed(stream);
    const printed = probe.take();
    probe.dispose();

    expect(printed).toContain(BOM);
    expect(visibleText(stream)).not.toContain(BOM);
    expect(compactSignalText(visibleText(stream))).toBe(compactSignalText(printed));
    expect(compactSignalText(`[bx:pr-${BOM}fixed:tok123abc]`)).toBe(MARKER);
  });

  it.each([
    ['CUP', `${ESC}[2;1H`],
    ['CRLF', '\r\n'],
  ])('does not infer prior-row occupancy before a %s continuation', async (_name, move) => {
    const stream =
      `${ESC}[1;10Hz${ESC}[1;1H[bx:pr-${move}fixed:tok123abc]`;
    expect(compactSignalText(await screenText(stream))).not.toContain(MARKER);
    expect(compactSignalText(visibleText(stream))).toContain(MARKER);
  });
});

describe('terminal control-string marker visibility', () => {
  it.each([
    ['OSC cancelled by a CSI', `${ESC}]0;title${ESC}[31m${MARKER}${BEL}`],
    ['OSC cancelled by CAN', `${ESC}]0;title\x18${MARKER}${BEL}`],
    ['OSC cancelled by SUB', `${ESC}]0;title\x1a${MARKER}${BEL}`],
    ['marker split by an 8-bit CSI', '[bx:pr-\x9b31mfixed:tok123abc]'],
    ['marker split by a 7-bit SGR', `[bx:pr-${ESC}[31mfixed:tok123abc]`],
    ['APC cancelled by an 8-bit CSI', `${ESC}_title\x9b31m${MARKER}${ESC}\\`],
  ])('shows the marker: %s', (_name, stream) => {
    expect(compactSignalText(visibleText(stream))).toContain(MARKER);
  });

  it.each([
    ['OSC closed by an 8-bit ST', `${ESC}]0;${MARKER}${ST}`],
    ['8-bit OSC introducer', `\x9d0;${MARKER}${ST}`],
    ['APC', `${ESC}_${MARKER}${ESC}\\`],
    ['PM', `${ESC}^${MARKER}${ESC}\\`],
    ['SOS', `${ESC}X${MARKER}${ESC}\\`],
    ['DCS', `${ESC}P${MARKER}${ESC}\\`],
  ])('hides the marker: %s', (_name, stream) => {
    expect(visibleText(stream)).toBe('');
  });

  it('keeps an unterminated control string open across chunks, however it is split', () => {
    const extractor = new VisibleTextExtractor();
    expect(extractor.write(`${ESC}]0;`)).toBe('');
    expect(extractor.write(MARKER)).toBe('');
    expect(extractor.write(BEL)).toBe('');
    expect(extractor.write('after')).toBe('after');
  });

  it('stays inside an OSC payload longer than the watcher tail buffer', () => {
    const extractor = new VisibleTextExtractor();
    extractor.write(`${ESC}]1337;`);
    expect(extractor.write('x'.repeat(4096))).toBe('');
    expect(extractor.write(MARKER)).toBe('');
    expect(extractor.write(`${BEL}visible`)).toBe('visible');
  });

  it('reset() returns a mid-sequence decoder to ground', () => {
    const extractor = new VisibleTextExtractor();
    extractor.write(`${ESC}]0;`);
    extractor.reset();
    expect(extractor.write(MARKER)).toBe(MARKER);
  });
});

describe('a cursor rewind breaks adjacency', () => {
  const MARKER_RE = /\[bx:pr-fixed:[A-Za-z0-9_-]{6,64}\]/;

  it('does not claim a marker that backspacing erased from the screen', async () => {
    const stream = '[bx:pr-\x08fixed:tok123abc]';
    expect((await screenText(stream)).trim()).toBe('[bx:prfixed:tok123abc]');
    expect(compactSignalText(visibleText(stream))).not.toMatch(MARKER_RE);
  });

  it.each([
    ['BEL', '\x07'],
    ['NUL', '\x00'],
    ['CAN', '\x18'],
    ['DEL', '\x7f'],
  ])('still matches across %s, which leaves the screen untouched', async (_name, control) => withoutParserNoise(async () => {
      const stream = `[bx:pr-${control}fixed:tok123abc]`;
      expect((await screenText(stream)).trim()).toBe('[bx:pr-fixed:tok123abc]');
      expect(compactSignalText(visibleText(stream))).toMatch(MARKER_RE);
  }));

  it('never claims a marker the screen does not show, across the whole C0/C1 range', async () => withoutParserNoise(async () => {
      for (let code = 0; code <= 0x9f; code++) {
        if (code === 0x1b) continue;
        const stream = `[bx:pr-${String.fromCharCode(code)}fixed:tok123abc]`;
        const ours = MARKER_RE.test(compactSignalText(visibleText(stream)));
        if (!ours) continue;
        const onScreen = MARKER_RE.test(compactSignalText(await screenText(stream)));
        expect(onScreen, `0x${code.toString(16)} matched for us but not on screen`).toBe(true);
      }
  }));

  it('keeps soft wrap and SGR tolerance intact', () => {
    expect(compactSignalText(visibleText('[bx:pr-\r\nfixed:tok123abc]'))).toMatch(MARKER_RE);
    expect(compactSignalText(visibleText('[bx:pr-\x1b[31mfixed:tok123abc]'))).toMatch(MARKER_RE);
  });

  it.each([
    ['a bare CR', '\r'],
    ['CR followed by EL(0)', `\r${ESC}[K`],
  ])('rejects a marker overwritten by %s', async (_name, sequence) => {
    const stream = `[bx:pr-${sequence}fixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(false);
    expect(compactSignalText(visibleText(stream))).not.toMatch(MARKER_RE);
  });

  it.each([
    ['CRLF continues at the next row', '\r\n'],
    ['CHA returns to the exact continuation column after CR', `\r${ESC}[8G`],
  ])('keeps a marker when %s', async (_name, sequence) => {
    const stream = `[bx:pr-${sequence}fixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
    expect(compactSignalText(visibleText(stream))).toMatch(MARKER_RE);
  });

  it('still sees a complete marker reprinted after CR', async () => {
    const stream = `[bx:pr-\r${MARKER}`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
    expect(compactSignalText(visibleText(stream))).toMatch(MARKER_RE);
  });
});

describe('7-bit CSI cursor state preserves only real marker adjacency', () => {
  const MARKER_RE = /\[bx:pr-fixed:[A-Za-z0-9_-]{6,64}\]/;
  const seesMarker = (stream: string): boolean =>
    MARKER_RE.test(compactSignalText(visibleText(stream)));

  it('rejects the issue reproduction that xterm renders without a marker', async () => {
    const stream = `[bx:pr-${ESC}[6Dfixed:tok123abc]`;
    expect((await screenText(stream)).trim()).toBe('[fixed:tok123abc]');
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([
    ['ECH', 'X'],
    ['ICH', '@'],
    ['DCH', 'P'],
  ])('rejects a marker when %s edits cells inside the prefix', async (_name, final) => {
    const stream = `[bx:pr-${ESC}[3G${ESC}[6${final}${ESC}[8Gfixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it('keeps a marker when ECH ends before the prefix starts', async () => {
    const stream =
      `${ESC}[10G[bx:pr-${ESC}[1G${ESC}[5X${ESC}[17Gfixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it.each([
    ['DECIC', '}'],
    ['DECDC', '~'],
  ])('rejects a marker when %s edits columns inside the prefix', async (_name, final) => {
    const stream =
      `[bx:pr-${ESC}[3G${ESC}[1'${final}${ESC}[8Gfixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([
    ['DECIC', '}'],
    ['DECDC', '~'],
  ])('keeps a marker when %s starts after the prefix', async (_name, final) => {
    const stream =
      `[bx:pr-${ESC}[10G${ESC}[1'${final}${ESC}[8Gfixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it.each([
    ['CHT', `[bx:pr-${ESC}[2147483647Ifixed:tok123abc]`],
    ['CBT', `${ESC}[20G[bx:pr-${ESC}[2147483647Zfixed:tok123abc]`],
  ])('handles the maximum parameter for %s in constant time', (_name, stream) => {
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([
    ['CUB overwrites the prefix', `${ESC}[6D`],
    ['CUF leaves an unprinted gap', `${ESC}[5C`],
    ['CHA moves back into the prefix', `${ESC}[3G`],
    ['HPA moves past the continuation column', `${ESC}[20\``],
    ['CUP moves back into the prefix', `${ESC}[1;3H`],
    ['HVP moves past the continuation column', `${ESC}[1;20f`],
    ['CUD moves below the continuation cell', `${ESC}[B`],
    ['CHT skips to the next tab stop', `${ESC}[I`],
    ['CBT moves to the previous tab stop', `${ESC}[Z`],
    ['VPR moves below the continuation cell', `${ESC}[e`],
    ['DECSTBM homes the cursor', `${ESC}[r`],
    ['origin mode homes the cursor', `${ESC}[?6h`],
    ['REP inserts a byte not present in the stream', `${ESC}[b`],
    ['IL replaces the active row', `${ESC}[L`],
    ['DL replaces the active row', `${ESC}[M`],
    ['SU scrolls the prefix away', `${ESC}[S`],
    ['SD separates the prefix from the cursor', `${ESC}[T`],
  ])('rejects a marker when %s', (_name, sequence) => {
    expect(seesMarker(`[bx:pr-${sequence}fixed:tok123abc]`)).toBe(false);
  });

  it('fails closed after TBC changes the tab-stop layout', async () => {
    const stream = `${ESC}[3g[bx:pr-${ESC}[I${ESC}[Dfixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it('fails closed on CHT after HTS changes the tab-stop layout', async () => {
    const stream =
      `${ESC}[3g${ESC}[13G${ESC}H${ESC}[1G[bx:pr-${ESC}[I${ESC}[5Dfixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
    expect(seesMarker(stream)).toBe(false);
  });

  it('fails closed when HT crosses a cell whose existing content is unknown', async () => {
    const stream =
      `${ESC}[1;8Hz${ESC}[1;1H[bx:pr-\tfixed:tok123abc]`;
    expect((await screenText(stream)).trim()).toBe('[bx:pr-zfixed:tok123abc]');
    expect(seesMarker(stream)).toBe(false);
  });

  it('keeps a marker when an HT detour returns to the exact continuation cell', async () => {
    const stream = `[bx:pr-\t${ESC}[Dfixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it('reanchors the cursor after an uncertain custom-tab movement', () => {
    const stream = `${ESC}[3g${ESC}[I${ESC}[1;1H${MARKER}`;
    expect(seesMarker(stream)).toBe(true);
  });

  it.each([
    ['CUP continues at the start of the next row', `${ESC}[2;1H`],
    ['HVP continues at the start of the next row', `${ESC}[2;1f`],
    ['EL erases only to the right', `${ESC}[K`],
    ['a saved cursor is restored without moving', `${ESC}[s${ESC}[u`],
    ['cursor movement returns to the continuation cell', `${ESC}[5C${ESC}[5D`],
    ['CSI u returns from a detour to the continuation cell', `${ESC}[s${ESC}[5C${ESC}[u`],
    ['CUU is clamped at the top edge', `${ESC}[A`],
    ['VPA names the current first row', `${ESC}[d`],
    ['ED erases only after the cursor', `${ESC}[J`],
    ['ED only clears scrollback', `${ESC}[3J`],
    ['ICH leaves the prefix left of the cursor intact', `${ESC}[@`],
    ['DCH leaves the prefix left of the cursor intact', `${ESC}[P`],
    ['ECH leaves the prefix left of the cursor intact', `${ESC}[X`],
    ['a 1049 alternate-screen round trip restores the cursor', `${ESC}[?1049h${ESC}[?1049l`],
    ['a 47 alternate-screen round trip restores the cursor', `${ESC}[?47h${ESC}[?47l`],
  ])('keeps a marker when %s', (_name, sequence) => {
    expect(seesMarker(`[bx:pr-${sequence}fixed:tok123abc]`)).toBe(true);
  });

  it('rejects a jump that crosses a row containing earlier output', async () => {
    const stream =
      `${ESC}[2;1HX${ESC}[1;1H[bx:pr-${ESC}[3;1Hfixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([
    ['EL(0)', `${ESC}[3G${ESC}[K${ESC}[8G`],
    ['ED(0)', `${ESC}[3G${ESC}[J${ESC}[8G`],
  ])('rejects a marker when %s erases part of the prefix before the cursor returns', async (_name, sequence) => {
    const stream = `[bx:pr-${sequence}fixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([
    ['a later row', `${ESC}[2;1H[bx:pr-${ESC}[s${ESC}[1;1H`],
    ['later columns on the same row', `${ESC}[10G[bx:pr-${ESC}[s${ESC}[5G`],
  ])('keeps a marker when ED(1) ends before the prefix on %s', async (_name, setup) => {
    const stream = `${setup}${ESC}[1J${ESC}[ufixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it('rejects a marker when ED(1) reaches the prefix on the current row', async () => {
    const stream =
      `${ESC}[10G[bx:pr-${ESC}[s${ESC}[12G${ESC}[1J${ESC}[ufixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([1, 2])(
    'applies EL(%s) only when the erased row contains the pending projection',
    async (mode) => {
      const safe =
        `[bx:pr-${ESC}[s${ESC}[B${ESC}[${mode}K${ESC}[ufixed:tok123abc]`;
      const destructive = `[bx:pr-${ESC}[${mode}K${ESC}[8Gfixed:tok123abc]`;
      expect(MARKER_RE.test(compactSignalText(await screenText(safe)))).toBe(true);
      expect(seesMarker(safe)).toBe(true);
      expect(MARKER_RE.test(compactSignalText(await screenText(destructive)))).toBe(false);
      expect(seesMarker(destructive)).toBe(false);
    },
  );

  it.each(['L', 'M'])(
    'keeps a saved continuation when CSI %s edits only lower lines',
    async (final) => {
      const stream =
        `[bx:pr-${ESC}7${ESC}[B${ESC}[${final}${ESC}8fixed:tok123abc]`;
      expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(true);
      expect(seesMarker(stream)).toBe(true);
    },
  );

  it.each(['K', 'J'])('keeps a marker when CSI %s starts after a right-edge prefix', async (final) => {
    const stream = `${ESC}[74G[bx:pr-${ESC}[${final}${ESC}[2;1Hfixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it.each([
    ['pending wrap', `${ESC}[74G[bx:pr-${ESC}[74G${ESC}[K${ESC}[2;1Hfixed:tok123abc]`],
    ['CRLF', `[bx:pr-\r\n${ESC}[1;1H${ESC}[K${ESC}[2;1Hfixed:tok123abc]`],
  ])('rejects EL(0) on the previous row after %s', async (_name, stream) => {
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it('keeps EL(0) on the new row after CRLF', async () => {
    const stream = `[bx:pr-\r\n${ESC}[Kfixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it.each([
    ['CSI save/restore', `${ESC}[s`, `${ESC}[u`],
    ['DECSC/DECRC', `${ESC}7`, `${ESC}8`],
  ])('keeps a marker when %s returns from a C0 tab detour', async (_name, save, restore) => {
    const stream = `[bx:pr-${save}\t${restore}fixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it.each([
    ['CSI save/restore', `${ESC}[s`, `${ESC}[u`],
    ['DECSC/DECRC', `${ESC}7`, `${ESC}8`],
  ])('does not restore a continuation after %s enclosed printable output', async (_name, save, restore) => {
    const destructive = `[bx:pr-${save}fixed:${restore}tok123abc]`;
    const safe = `[bx:pr-${save}\t${restore}fixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(destructive)))).toBe(false);
    expect(seesMarker(destructive)).toBe(false);
    expect(MARKER_RE.test(compactSignalText(await screenText(safe)))).toBe(true);
    expect(seesMarker(safe)).toBe(true);
  });

  it.each(['47', '1047', '1049'])(
    'keeps repeated DECSET ?%s idempotent while already on the alternate screen',
    async (mode) => {
      const stream = `${ESC}[?${mode}h[bx:pr-${ESC}[?${mode}hfixed:tok123abc]`;
      expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
      expect(seesMarker(stream)).toBe(true);
    },
  );

  it.each(['47', '1047'])(
    'propagates alternate-screen cursor movement when clearing ?%s',
    async (mode) => {
      const stream =
        `[bx:pr-${ESC}[?${mode}h${ESC}[5C${ESC}[?${mode}lfixed:tok123abc]`;
      expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(false);
      expect(seesMarker(stream)).toBe(false);
    },
  );

  it.each(['47', '1047'])(
    'keeps a marker when alternate-screen movement returns before clearing ?%s',
    async (mode) => {
      const stream =
        `[bx:pr-${ESC}[?${mode}h${ESC}[5C${ESC}[5D${ESC}[?${mode}lfixed:tok123abc]`;
      expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
      expect(seesMarker(stream)).toBe(true);
    },
  );

  it.each(['47', '1047', '1049'])(
    'rejects a stale continuation after alternate screen ?%s is cleared and reactivated',
    async (mode) => {
      const stream =
        `${ESC}[?${mode}h[bx:pr-${ESC}[?${mode}l${ESC}[1;8H`
        + `${ESC}[?${mode}hfixed:tok123abc]`;
      expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
      expect(seesMarker(stream)).toBe(false);
    },
  );

  it.each(['47', '1047', '1049'])(
    'does not restore a saved continuation after alternate screen ?%s is cleared and reactivated',
    async (mode) => {
      const stream =
        `${ESC}[?${mode}h[bx:pr-${ESC}[s${ESC}[?${mode}lX`
        + `${ESC}[?${mode}h${ESC}[ufixed:tok123abc]`;
      expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
      expect(seesMarker(stream)).toBe(false);
    },
  );

  it.each(['47', '1047', '1049'])(
    'preserves the saved cursor position when alternate screen ?%s is cleared and reactivated',
    async (mode) => {
      const stream =
        `${ESC}[?${mode}h${ESC}[3;11H${ESC}[s${ESC}[?${mode}l${ESC}[1;1H`
        + `${ESC}[?${mode}h${ESC}[u[bx:pr-${ESC}[3;18Hfixed:tok123abc]`;
      expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(true);
      expect(seesMarker(stream)).toBe(true);
    },
  );

  it.each(['47', '1047', '1049'])(
    'keeps main-screen continuation isolated from an erase on alternate screen ?%s',
    async (mode) => {
      const stream = `[bx:pr-${ESC}[?${mode}h${ESC}[2J${ESC}[?${mode}lfixed:tok123abc]`;
      expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
      expect(seesMarker(stream)).toBe(true);
    },
  );

  it('keeps a main-screen invalidation across an alternate-screen round trip', async () => {
    const stream = `[bx:pr-${ESC}[2J${ESC}[?1049h${ESC}[?1049lfixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([
    ['CUD', `${ESC}[B`],
    ['VPR', `${ESC}[e`],
  ])('clamps %s at the bottom row', async (_name, sequence) => {
    const stream = `${ESC}[24;1H[bx:pr-${sequence}fixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it('clamps CUD at the active scroll margin', async () => {
    const stream = `${ESC}[5;10r${ESC}[10;1H[bx:pr-${ESC}[Bfixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it('rejects an out-of-range CUP that xterm clamps onto the prefix row', async () => {
    const stream = `${ESC}[24;1H[bx:pr-${ESC}[99;1Hfixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([
    ['CRLF scrolls the prefix and continues on the bottom row', '\r\n'],
    ['pending wrap scrolls the prefix and continues on the bottom row', ''],
  ])('keeps a marker when %s', async (name, sequence) => {
    const column = name.startsWith('pending') ? 74 : 1;
    const stream = `${ESC}[24;${column}H[bx:pr-${sequence}fixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it.each([
    ['IND', `${ESC}D`],
    ['LF', '\n'],
    ['VT', '\v'],
    ['FF', '\f'],
    ['NEL', `${ESC}E`],
  ])('keeps a marker when %s starts at the continuation cell', async (_name, sequence) => {
    const stream = `[bx:pr-${sequence}fixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it.each([
    ['IND', `${ESC}D`],
    ['LF', '\n'],
    ['VT', '\v'],
    ['FF', '\f'],
    ['NEL', `${ESC}E`],
  ])('rejects a marker when %s returns from a non-adjacent row', async (_name, sequence) => {
    const stream =
      `${ESC}[2;1H[bx:pr-${ESC}[F${sequence}fixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([
    [
      'CRLF',
      `${ESC}[1;2r${ESC}[2;1H[bx:pr-\r\n${ESC}[1;1H${ESC}[2K${ESC}[2;1Hfixed:tok123abc]`,
    ],
    [
      'pending wrap',
      `${ESC}[1;2r${ESC}[2;74H[bx:pr-f${ESC}[1;1H${ESC}[2K${ESC}[2;2Hixed:tok123abc]`,
    ],
  ])('tracks the printed extent after a %s scroll', async (_name, stream) => {
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([
    [23, true],
    [24, false],
  ])(
    'tracks whether ED(3) clears a prefix after %i full-screen scrolls',
    async (scrolls, expected) => {
      const stream =
        `${ESC}[24;1H[bx:pr-${'\r\n'.repeat(scrolls)}${ESC}[3Jfixed:tok123abc]`;
      expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(expected);
      expect(seesMarker(stream)).toBe(expected);
    },
  );

  it.each([
    ['main buffer', '', true],
    ['alternate buffer', `${ESC}[?47h`, false],
  ])(
    'tracks whether full-screen scrolling preserves a prefix in the %s',
    async (_name, enter, expected) => {
      const stream =
        `${enter}${ESC}[24;1H[bx:pr-${'\r\n'.repeat(24)}fixed:tok123abc]`;
      expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(expected);
      expect(seesMarker(stream)).toBe(expected);
    },
  );

  it.each([
    ['CRLF', 1, '\r\n'],
    ['pending wrap', 74, ''],
  ])('rejects %s at the screen bottom outside the scroll region', async (_name, column, sequence) => {
    const stream = `${ESC}[1;10r${ESC}[24;${column}H[bx:pr-${sequence}fixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([
    ['EL erases the prefix to the left', `${ESC}[1K`],
    ['EL erases the whole row', `${ESC}[2K`],
    ['ED erases the prefix to the left', `${ESC}[1J`],
    ['ED erases the whole viewport', `${ESC}[2J`],
    ['DECSEL erases an unprotected prefix', `${ESC}[?1K`],
    ['DECSED erases an unprotected viewport', `${ESC}[?2J`],
    ['printing continues on a different screen', `${ESC}[?1049h`],
  ])('rejects a marker when %s', (_name, sequence) => {
    expect(seesMarker(`[bx:pr-${sequence}fixed:tok123abc]`)).toBe(false);
  });

  it.each([
    ['CSI u', `${ESC}[s`, `${ESC}[u`],
    ['DECRC', `${ESC}7`, `${ESC}8`],
  ])('rejects a marker when %s restores a cursor inside the prefix', (_name, save, restore) => {
    expect(seesMarker(`${save}[bx:pr-${restore}fixed:tok123abc]`)).toBe(false);
  });

  it('never completes off screen across the supported cursor and mutation CSI matrix', async () => {
    const finals = Array.from({ length: 0x7f - 0x40 }, (_, i) => String.fromCharCode(0x40 + i));
    const params = ['', '0', '1', '2', '5', '1;1', '2;1', '1;20', '20;1', '24;1', '99;1'];
    const sequences = finals.flatMap(final => params.map(param => `${ESC}[${param}${final}`));
    for (const sequence of sequences) {
      const stream = `[bx:pr-${sequence}fixed:tok123abc]`;
      if (!seesMarker(stream)) continue;
      const screen = (await screenText(stream)).replaceAll('\n', '');
      expect(MARKER_RE.test(screen), JSON.stringify(sequence)).toBe(true);
    }
  });

  it('uses terminal width to recognise a nonzero-column continuation after wrapping', async () => {
    const stream = `${ESC}[78G[bx:pr-${ESC}[2;5Hfixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it('preserves delayed-wrap semantics when CUB moves back from the right edge', () => {
    const stream = `${ESC}[74G[bx:pr-${ESC}[Dfixed:tok123abc]`;
    expect(seesMarker(stream)).toBe(false);
  });

  it.each([
    ['CR', `${ESC}[24;74H[bx:pr-\rfixed:tok123abc]`],
    [
      'CUB and CUP',
      `${ESC}[24;74H[bx:pr-${ESC}[D${ESC}[24;1Hfixed:tok123abc]`,
    ],
  ])('rejects a bottom-row pending wrap cancelled by %s', async (_name, stream) => {
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it('separates bytes that overwrite the rightmost cell when wraparound is disabled', async () => {
    const stream = `${ESC}[?7l${ESC}[74G${MARKER}`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it('fails closed when a preceding wide glyph makes an absolute column ambiguous', async () => {
    const stream = `中[bx:pr-${ESC}[9Gfixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(false);
    expect(seesMarker(stream)).toBe(false);
  });

  it('re-establishes reliable coordinates after a full absolute position', async () => {
    const stream = `中${ESC}[1;1H[bx:pr-${ESC}[2;1Hfixed:tok123abc]`;
    expect(MARKER_RE.test((await screenText(stream)).replaceAll('\n', ''))).toBe(true);
    expect(seesMarker(stream)).toBe(true);
  });

  it('separates output across a resize until the new geometry has a fresh print anchor', () => {
    const extractor = new VisibleTextExtractor(80);
    let visible = extractor.write('[bx:pr-');
    extractor.resize(20);
    visible += extractor.write('fixed:tok123abc]');
    expect(MARKER_RE.test(compactSignalText(visible))).toBe(false);
    expect(compactSignalText(extractor.write(MARKER))).toContain(MARKER);
  });

  it('keeps cursor state across arbitrary write boundaries', () => {
    const extractor = new VisibleTextExtractor();
    let visible = extractor.write('[bx:pr-');
    visible += extractor.write(`${ESC}[`);
    visible += extractor.write('6');
    visible += extractor.write('Dfixed:tok123abc]');
    expect(MARKER_RE.test(compactSignalText(visible))).toBe(false);
  });
});

describe('8-bit CSI marker detection matches the rendered screen', () => {
  const MARKER_RE = /\[bx:pr-fixed:[A-Za-z0-9_-]{6,64}\]/;
  const BASE_OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
  const BASE_ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
  const baseSees = (stream: string): boolean =>
    MARKER_RE.test(compactSignalText(stream.replace(BASE_OSC_RE, '').replace(BASE_ANSI_RE, '')));
  const oursSees = (stream: string): boolean => MARKER_RE.test(compactSignalText(visibleText(stream)));
  const screenSees = async (stream: string): Promise<boolean> =>
    MARKER_RE.test(compactSignalText(await screenText(stream)));

  it.each([
    ['CUB rewinds over the prefix', '\x9b6D'],
    ['CUP lands back inside the marker', '\x9b1;3H'],
    ['EL wipes the line', '\x9b2K'],
    ['DECRC returns to the saved column', '\x9bu'],
  ])('%s, so neither the screen nor base sees a marker', async (_name, sequence) => {
    const stream = `[bx:pr-${sequence}fixed:tok123abc]`;
    expect(await screenSees(stream)).toBe(false);
    expect(baseSees(stream)).toBe(false);
    expect(oursSees(stream)).toBe(false);
  });

  it.each([
    ['8-bit conceal', '[bx:pr-\x9b8mfixed:tok123abc]'],
    ['7-bit conceal', `[bx:pr-${ESC}[8mfixed:tok123abc]`],
    ['conceal reaching past a later reveal', '[bx:pr-\x9b8mfixed\x9b28m:tok123abc]'],
  ])('%s hides the tail, so no marker is claimed', async (_name, stream) => {
    expect(await screenHides(`${ESC}[8m`)).toBe(true);
    expect(oursSees(stream)).toBe(false);
  });

  it('still reads through an 8-bit SGR that only sets colour', async () => {
    const stream = '[bx:pr-\x9b31mfixed:tok123abc]';
    expect(await screenHides(`${ESC}[31m`)).toBe(false);
    expect(oursSees(stream)).toBe(true);
  });

  it.each([
    ['CAN, after CR already redrew the line inside the CSI', '[bx:pr-\x9b\r\x18fixed:tok123abc]', false],
    ['CAN mid-parameter', '[bx:pr-\x9b1\x18fixed:tok123abc]', true],
    ['SUB mid-parameter', '[bx:pr-\x9b1\x1afixed:tok123abc]', true],
    ['a C1 control', '[bx:pr-\x9b1\x84fixed:tok123abc]', true],
    ['a non-ASCII byte on the parser error path', '[bx:pr-\x9b1éfixed:tok123abc]', true],
    ['a final that leaves csiIgnore', '[bx:pr-\x9b1?mfixed:tok123abc]', true],
  ])('follows the screen when %s ends the sequence', async (_name, stream, visible) => withoutParserNoise(async () => {
      expect(await screenSees(stream)).toBe(visible);
      expect(oursSees(stream)).toBe(visible);
  }));

  it('tracks conceal through every save, restore and reset the charset uses', async () => {
    const SGRS = ['', '0', '8', '28', '08', '8:1', '28:0', '1;8', '8;28', '28;8', '31', '108'];
    const WRAPS: Array<[string, (sgr: string) => string]> = [
      ['bare', sgr => sgr],
      ['DECSC/DECRC', sgr => `${ESC}7${sgr}${ESC}8`],
      ['concealed before DECSC', sgr => `${ESC}7${ESC}[8m${sgr}${ESC}8`],
      ['CSI s / CSI u', sgr => `${ESC}[s${sgr}${ESC}[u`],
      ['?1048 save/restore', sgr => `${ESC}[?1048h${sgr}${ESC}[?1048l`],
      ['?1049 save/restore', sgr => `${ESC}[?1049h${sgr}${ESC}[?1049l`],
      ['?47 buffer switch', sgr => `${ESC}[?47h${sgr}${ESC}[?47l`],
      ['then RIS', sgr => `${sgr}${ESC}c`],
      ['then DECSTR', sgr => `${sgr}${ESC}[!p`],
      ['then CSI ?2h', sgr => `${sgr}${ESC}[?2h`],
      ['8-bit form', sgr => sgr.split(`${ESC}[`).join('\x9b')],
      ['private prefix, so no dispatch', sgr => sgr.split(`${ESC}[`).join(`${ESC}[?`)],
      ['intermediate, so no dispatch', sgr => sgr.split(`${ESC}[`).join(`${ESC}[" `)],
    ];
    for (const sgr of SGRS) {
      for (const [name, wrap] of WRAPS) {
        for (const lead of ['', `${ESC}[8m`, `${ESC}[28m`]) {
          const prefix = lead + wrap(`${ESC}[${sgr}m`);
          const label = `${name} lead=${JSON.stringify(lead)} sgr=${JSON.stringify(sgr)}`;
          expect(!visibleText(`${prefix}X`).includes('X'), label).toBe(await screenHides(prefix));
        }
      }
    }
  }, 60_000);

  it.each([
    ['an 8-bit SGR that would otherwise be transparent', '[bx:pr-\x9b\r31mfixed:tok123abc]'],
    ['an 8-bit CSI leaving through csiIgnore', '[bx:pr-\x9b1?\rmfixed:tok123abc]'],
    ['a 7-bit CSI', `[bx:pr-${ESC}[\r31mfixed:tok123abc]`],
    ['a 7-bit CSI leaving through csiIgnore', `[bx:pr-${ESC}[1?\rmfixed:tok123abc]`],
  ])('a CR executed inside %s still separates', (_name, stream) => {
    expect(baseSees(stream)).toBe(false);
    expect(oursSees(stream)).toBe(false);
  });

  it('separates on ESC M, which the 8-bit 0x8d form does not trigger in 5.5.0', async () => {
    for (const stream of [`\n[bx:pr-${ESC}Mfixed:tok123abc]`, `[bx:pr-${ESC}Mfixed:tok123abc]`]) {
      expect(await screenSees(stream), stream).toBe(false);
      expect(oursSees(stream), stream).toBe(false);
    }
    for (const forward of [`${ESC}D`, `${ESC}E`, '\x84', '\x85', '\x8d']) {
      const stream = `\n[bx:pr-${forward}fixed:tok123abc]`;
      expect(await screenSees(stream), stream).toBe(true);
      expect(oursSees(stream), stream).toBe(true);
    }
  });

  it('follows the extended-colour payload span instead of reading every parameter', async () => {
    const LEADERS = ['38', '48', '58', '39', '4'];
    const SUBS = ['', '0', '1', '2', '3', '4', '5', '9', '28', '8'];
    const FILLS = ['', '1', '1;1', '1;1;1', '1;1;1;1', '1;1;1;1;1'];
    const TAILS = ['', ';28', ';8', ';0', ';28;8', ';8;28'];
    const SUBPARAMS: Array<(body: string) => string> = [
      body => body,
      body => body.replace(/^(\d+)/, '$1:5:1'),
      body => body.replace(/;1/, ';1:2'),
    ];
    for (const leader of LEADERS) {
      for (const sub of SUBS) {
        for (const fill of FILLS) {
          for (const tail of TAILS) {
            for (const subparams of SUBPARAMS) {
              const body = subparams([leader, sub, fill].filter(Boolean).join(';')) + tail;
              for (const lead of [`${ESC}[8m`, '']) {
                const prefix = `${lead}${ESC}[${body}m`;
                const label = `${JSON.stringify(lead)} ESC[${body}m`;
                expect(!visibleText(`${prefix}X`).includes('X'), label).toBe(await screenHides(prefix));
              }
            }
          }
        }
      }
    }
  }, 120_000);

  it('never completes where the screen does not, nor misses what base saw', async () => withoutParserNoise(async () => {
    const CANCELS = ['', '\x18', '\x1a', ' '];
    for (let final = 0x40; final <= 0x7e; final++) {
      for (const prefix of ['', '?', '>', '<', '=']) {
        for (const params of ['', '2', '8', '1;3', '25']) {
          for (const intermediate of ['', ' ', '!']) {
            for (const cancel of CANCELS) {
              const sequence = cancel === ''
                ? `\x9b${prefix}${params}${intermediate}${String.fromCharCode(final)}`
                : `\x9b${prefix}${params}${intermediate}${cancel}`;
              const stream = `[bx:pr-${sequence}fixed:tok123abc]`;
              const ours = oursSees(stream);
              const label = JSON.stringify(sequence);
              if (ours) expect(await screenSees(stream), `${label}: completed off screen`).toBe(true);
              if (baseSees(stream)) expect(ours, `${label}: lost a marker base saw`).toBe(true);
            }
          }
        }
      }
    }
  }), 120_000);
});

describe('a designated charset makes printed ASCII untrustworthy', () => {
  const MARKER_RE = /\[bx:pr-fixed:[A-Za-z0-9_-]{6,64}\]/;
  const SO = '\x0e';
  const SI = '\x0f';

  it.each([
    ['G1 = DEC graphics, SO/SI around the middle', `[bx:pr-${ESC})0${SO}fixed${SI}:tok123abc]`],
    ['G0 = DEC graphics, no shift needed', `${ESC}(0[bx:pr-fixed:tok123abc]`],
    ['G0 designated mid-marker', `[bx:pr-${ESC}(0fixed:tok123abc]`],
    ['G2 designated then locked in with LS2', `${ESC}*0${ESC}n[bx:pr-fixed:tok123abc]`],
    ['G3 designated then locked in with LS3', `${ESC}+0${ESC}o[bx:pr-fixed:tok123abc]`],
  ])('does not claim a marker the charset rewrote: %s', async (_name, stream) => {
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
    expect(compactSignalText(visibleText(stream))).not.toMatch(MARKER_RE);
  });

  it.each([
    ['SO with G1 never designated', `[bx:pr-${SO}fixed${SI}:tok123abc]`],
    ['explicit US-ASCII designation', `${ESC}(B[bx:pr-fixed:tok123abc]`],
    ['DEC graphics switched back before the marker', `${ESC}(0box${ESC}(B[bx:pr-fixed:tok123abc]`],
  ])('still matches when the screen really shows the marker: %s', async (_name, stream) => {
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(true);
    expect(compactSignalText(visibleText(stream))).toMatch(MARKER_RE);
  });

  it('matches the screen byte for byte, for every designator and every printable ASCII', async () => {
    const ascii = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)).join('');
    for (let code = 0x30; code <= 0x7e; code++) {
      const designator = String.fromCharCode(code);
      const stream = `${ESC}(${designator}${ascii}`;
      const onScreen = (await wideRow0(stream)).slice(0, ascii.length);
      const ours = visibleText(stream);
      expect(ours, `designator ${JSON.stringify(designator)} length`).toHaveLength(ascii.length);
      for (let i = 0; i < ascii.length; i++) {
        expect(
          ours[i] !== ascii[i],
          `designator ${JSON.stringify(designator)} byte ${JSON.stringify(ascii[i])}`,
        ).toBe(onScreen[i] !== ascii[i]);
      }
    }
  });

  it('keeps a marker that a partially-remapping charset leaves intact', async () => {
    const stream = `${ESC}(A[bx:pr-fixed:tok123abc]`;
    expect((await screenText(stream)).trim()).toBe('[bx:pr-fixed:tok123abc]');
    expect(compactSignalText(visibleText(stream))).toMatch(MARKER_RE);
    expect(visibleText(`${ESC}(A#`)).not.toBe('#');
  });

  it.each([
    ['SI selects G0', '\x0f', '('],
    ['SO selects G1', SO, ')'],
    ['LS2 selects G2', `${ESC}n`, '*'],
    ['LS3 selects G3', `${ESC}o`, '+'],
    ['LS2R selects G2', `${ESC}}`, '*'],
    ['LS3R selects G3', `${ESC}|`, '+'],
    ['LS1R selects G1', `${ESC}~`, ')'],
  ])('follows the terminal through %s', async (_name, shift, intermediate) => {
    const stream = `${ESC}(B${ESC}${intermediate}0${shift}[bx:pr-fixed:tok123abc]`;
    const onScreen = MARKER_RE.test(compactSignalText(await screenText(stream)));
    expect(MARKER_RE.test(compactSignalText(visibleText(stream)))).toBe(onScreen);
  });

  it.each([
    ['SS2', `${ESC}N`, '*'],
    ['SS3', `${ESC}O`, '+'],
  ])('tracks %s the same way the terminal does', async (_name, shift, intermediate) => {
    for (const marker of [`${shift}[bx:pr-fixed:tok123abc]`, `[bx:${shift}pr-fixed:tok123abc]`]) {
      const stream = `${ESC}(B${ESC}${intermediate}0${marker}`;
      const onScreen = MARKER_RE.test(compactSignalText(await screenText(stream)));
      expect(MARKER_RE.test(compactSignalText(visibleText(stream))), stream).toBe(onScreen);
    }
  });

  it('ignores GR-only designations, which never reach GL', async () => {
    for (const intermediate of ['-', '.', '/']) {
      const stream = `${ESC}(B${ESC}${intermediate}0[bx:pr-fixed:tok123abc]`;
      expect((await screenText(stream)).trim()).toBe('[bx:pr-fixed:tok123abc]');
      expect(compactSignalText(visibleText(stream))).toMatch(MARKER_RE);
    }
  });

  it('an aborted designation does not latch onto the next final byte', () => {
    expect(visibleText(`${ESC}(\x180[bx:pr-fixed:tok123abc]`)).toBe('0[bx:pr-fixed:tok123abc]');
  });

  it('reset() clears the charset selection', () => {
    const extractor = new VisibleTextExtractor();
    extractor.write(`${ESC}(0`);
    expect(extractor.write('abc')).not.toBe('abc');
    extractor.reset();
    expect(extractor.write('abc')).toBe('abc');
  });
});

describe('charset state follows the terminal', () => {
  const MARKER_RE = /\[bx:pr-fixed:[A-Za-z0-9_-]{6,64}\]/;
  const M = '[bx:pr-fixed:tok123abc]';

  async function agreesWithScreen(stream: string): Promise<void> {
    const onScreen = MARKER_RE.test(compactSignalText(await screenText(stream)));
    expect(MARKER_RE.test(compactSignalText(visibleText(stream))), stream).toBe(onScreen);
  }

  it.each([
    ['DECSC/DECRC restores the graphics set', `${ESC}(0${ESC}7${ESC}(B${ESC}8${M}`],
    ['DECSC/DECRC split across the marker', `${ESC}(0${ESC}7${ESC}(B[bx:pr-${ESC}8fixed:tok123abc]`],
    ['DECSC without DECRC leaves ASCII in place', `${ESC}(0${ESC}7${ESC}(B${M}`],
    ['DECRC with nothing saved', `${ESC}(0${ESC}8${M}`],
    ['CSI s / CSI u restores the graphics set', `${ESC}(0${ESC}[s${ESC}(B${ESC}[u${M}`],
    ['a private CSI ending in s is not a save', `${ESC}(0${ESC}[?1049s${ESC}(B${M}`],
  ])('%s', (_name, stream) => agreesWithScreen(stream));

  it.each([
    ['RIS', `${ESC}c`],
    ['DECSTR', `${ESC}[!p`],
    ['ESC % G', `${ESC}%G`],
    ['ESC % @', `${ESC}%@`],
  ])('%s puts the terminal back on US-ASCII, so the marker must be seen', (_name, reset) =>
    agreesWithScreen(`${ESC}(0${reset}${M}`));

  it.each([
    ['RIS', `${ESC}c`],
    ['DECALN', `${ESC}#8`],
  ])('%s wipes the screen, so the halves it separates are not one marker', async (_name, wipe) => {
    const stream = `[bx:pr-${wipe}fixed:tok123abc]`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
    expect(compactSignalText(visibleText(stream))).not.toMatch(MARKER_RE);
  });

  it('DECSTR does not wipe the screen, so it must not split a marker', () =>
    agreesWithScreen(`[bx:pr-${ESC}[!pfixed:tok123abc]`));

  it('reset() forgets saved charset state too', () => {
    const extractor = new VisibleTextExtractor();
    extractor.write(`${ESC}(0${ESC}7${ESC}(B`);
    extractor.reset();
    extractor.write(`${ESC}8`);
    expect(extractor.write('abc')).toBe('abc');
  });
});

describe('composite charset state agrees with the terminal', () => {
  const MARKER_RE = /\[bx:pr-fixed:[A-Za-z0-9_-]{6,64}\]/;
  const M = '[bx:pr-fixed:tok123abc]';
  const SO = '\x0e';
  const SI = '\x0f';

  const STATE_ATOMS = [
    `${ESC}(0`, `${ESC}(B`, `${ESC}(A`, `${ESC}(X`, `${ESC}(4`, `${ESC}( F`,
    `${ESC})0`, `${ESC})B`, `${ESC}*0`, `${ESC}+0`, `${ESC}-0`, `${ESC}.0`, `${ESC}/0`,
    SO, SI, `${ESC}n`, `${ESC}o`, `${ESC}~`, `${ESC}}`, `${ESC}|`,
    `${ESC}7`, `${ESC}8`, `${ESC}[s`, `${ESC}[u`, `${ESC}[?1049s`, `${ESC}[?1049u`,
    `${ESC}[?1049h`, `${ESC}[?1049l`, `${ESC}[?1048h`, `${ESC}[?1048l`,
    `${ESC}[?47h`, `${ESC}[?47l`, `${ESC}[?1047h`, `${ESC}[?1047l`,
    `${ESC}[?2h`, `${ESC}[?2l`, `${ESC}[?25h`, `${ESC}[?1049;1048h`,
    `${ESC}[!!p`, `${ESC}[" !p`, `${ESC}[!s`, `${ESC}[!u`,
    `${ESC}c`, `${ESC}[!p`, `${ESC}%G`, `${ESC}%@`, `${ESC}#8`,
    `${ESC}[31m`, `${ESC}]0;t\x07`, '',
  ];

  const CANARY = 'fixedmarker';
  const COMPOSITE_ROUNDS = Number(process.env.BX_COMPOSITE_ROUNDS ?? 400);

  it('agrees with the screen on 400 random state compositions', async () => {
    let seed = 0x51d3c7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)];
    const anyEscapeSequence = (): string =>
      ESC + pick([...'()*+-./%#$" ']) + String.fromCharCode(0x30 + Math.floor(rnd() * 0x4f));
    const anyCsiSequence = (): string =>
      `${ESC}[${pick(['', '?', '>', '<'])}${pick(['', '2', '25', '47', '1047', '1048', '1049', '1;2'])}`
      + `${pick(['', '!', '!!', '" ', '$'])}${String.fromCharCode(0x40 + Math.floor(rnd() * 0x3f))}`;

    const DESIGNATIONS = [`${ESC}(0`, `${ESC})0`, `${ESC}*0`, `${ESC}+0`, `${ESC}-0`, `${ESC}(A`, `${ESC}(X`, `${ESC}(B`];
    const SHIFTS = ['', SI, SO, `${ESC}n`, `${ESC}o`, `${ESC}~`, `${ESC}}`, `${ESC}|`];
    const SAVES = ['', `${ESC}7`, `${ESC}[s`, `${ESC}[?1049h`, `${ESC}[?1048h`,
      `${ESC}[?47h`, `${ESC}[?1047h`, `${ESC}[>1049h`, `${ESC}[<1048h`, `${ESC}[=1049h`,
      `${ESC}[?${'1'.repeat(27)};1049h`, `${ESC}[?${'1'.repeat(27)};10499h`];
    const RESTORES = ['', `${ESC}8`, `${ESC}[u`, `${ESC}[?1049l`, `${ESC}[?1048l`,
      `${ESC}[?47l`, `${ESC}[?1047l`, `${ESC}[>1049l`, `${ESC}[<1048l`, `${ESC}[=1049l`,
      `${ESC}[?${'1'.repeat(27)};1049l`, `${ESC}[?${'1'.repeat(27)};10499l`];
    const RESETS = ['', `${ESC}c`, `${ESC}[!p`, `${ESC}[!!p`, `${ESC}[?2h`, `${ESC}[>2h`,
      `${ESC}%G`, `${ESC}%@`, `${ESC}%X`];

    for (let round = 0; round < COMPOSITE_ROUNDS; round++) {
      const trajectory = pick(DESIGNATIONS) + pick(SHIFTS) + pick(SAVES) + pick(DESIGNATIONS)
        + pick(SAVES) + pick(SHIFTS) + pick(RESTORES) + pick(DESIGNATIONS) + pick(RESTORES)
        + pick(RESETS);
      let noise = '';
      for (let i = 0; i < Math.floor(rnd() * 3); i++) {
        const roll = rnd();
        noise += roll < 0.3 ? anyEscapeSequence() : roll < 0.6 ? anyCsiSequence() : pick(STATE_ATOMS);
      }
      const prefix = trajectory + noise;
      const trailingShift = pick(SHIFTS);
      const stream = `${prefix}${trailingShift}\r\n${CANARY}`;

      const screenRemapped = !(await screenText(stream)).includes(CANARY);
      const oursRemapped = !visibleText(stream).includes(CANARY);
      expect(oursRemapped, `round ${round}: ${JSON.stringify(prefix + trailingShift)}`).toBe(screenRemapped);
    }
  }, COMPOSITE_ROUNDS * 30);

  const OVERFLOW_PARAMS = Array.from({ length: 40 }, () => '1').join(';');
  const MANY_PARAMS = '1;2;3;4;5;6;7;8;9;10;11;12;13;14';
  const SAVE_OPS = ['', `${ESC}7`, `${ESC}[s`, `${ESC}[?1049h`, `${ESC}[?1048h`, `${ESC}[?47h`,
    `${ESC}[?1047h`, `${ESC}[>1049h`, `${ESC}[?${'1'.repeat(27)};1049h`, `${ESC}[?${'1'.repeat(27)};10499h`,
    `${ESC}[?01048h`, `${ESC}[?1049:0h`, `${ESC}[?1048;${MANY_PARAMS}h`,
    `${ESC}[?${OVERFLOW_PARAMS};1048h`, `${ESC}[?1048;${OVERFLOW_PARAMS}h`,
    `${ESC}[?1;2;3;4;5;6;7;8;9;10;1048h`];
  const RESTORE_OPS = ['', `${ESC}8`, `${ESC}[u`, `${ESC}[?1049l`, `${ESC}[?1048l`, `${ESC}[?47l`,
    `${ESC}[?1047l`, `${ESC}[>1049l`, `${ESC}[?${'1'.repeat(27)};1049l`, `${ESC}[?${'1'.repeat(27)};10499l`,
    `${ESC}[?01048l`, `${ESC}[?1049:0l`, `${ESC}[?1048;${MANY_PARAMS}l`,
    `${ESC}[?${OVERFLOW_PARAMS};1048l`, `${ESC}[?1048;${OVERFLOW_PARAMS}l`,
    `${ESC}[?1;2;3;4;5;6;7;8;9;10;1048l`];
  const RESET_OPS = ['', `${ESC}c`, `${ESC}[!p`, `${ESC}[?2h`, `${ESC}[>2h`, `${ESC}%G`, `${ESC}%X`];
  const BUFFER_OPS: Array<[string, string]> = [
    ['', ''], [`${ESC}[?1049h`, `${ESC}[?1049l`], [`${ESC}[?47h`, `${ESC}[?47l`],
    [`${ESC}[?1047h`, `${ESC}[?1047l`], [`${ESC}[>1049h`, `${ESC}[>1049l`],
  ];

  async function agreesOnCanary(prefix: string): Promise<void> {
    const stream = `${prefix}\r\n${CANARY}`;
    const screenRemapped = !(await screenText(stream)).includes(CANARY);
    expect(!visibleText(stream).includes(CANARY), JSON.stringify(prefix)).toBe(screenRemapped);
  }

  it('agrees on every save x reset x restore combination', async () => {
    for (const save of SAVE_OPS) {
      for (const reset of RESET_OPS) {
        for (const restore of RESTORE_OPS) {
          await agreesOnCanary(`${ESC}(0${save}${ESC}(B${reset}${restore}`);
        }
      }
    }
  }, 120_000);

  it('agrees on saves and restores taken across a buffer switch', async () => {
    const inner = [`${ESC}7`, `${ESC}[s`, `${ESC}[?1048h`];
    const innerRestore = ['', `${ESC}8`, `${ESC}[u`, `${ESC}[?1048l`];
    for (const [enter, leave] of BUFFER_OPS) {
      for (const save of inner) {
        for (const restore of innerRestore) {
          await agreesOnCanary(`${ESC}(0${enter}${save}${ESC}(B${restore}${leave}${ESC}8`);
          await agreesOnCanary(`${ESC}(0${enter}${ESC}(B${save}${leave}${restore}`);
        }
      }
    }
  }, 120_000);

  it('still reports a marker that a later screen wipe erased', async () => {
    const stream = `${M}${ESC}#8`;
    expect(MARKER_RE.test(compactSignalText(await screenText(stream)))).toBe(false);
    expect(compactSignalText(visibleText(stream))).toMatch(MARKER_RE);
  });

  it.each([
    ['an unrecognised designation leaves the old charset in place', `[bx:pr-${ESC}(0${ESC}(Xfixed:tok123abc]`],
    ['alt-screen enter/exit restores the charset it saved', `${ESC}(0${ESC}[?1049h${ESC}(B${ESC}[?1049l${M}`],
    ['?1048 save/restore does the same', `${ESC}(0${ESC}[?1048h${ESC}(B${ESC}[?1048l${M}`],
    ['?47 switches buffers without touching the charset', `${ESC}(0${ESC}[?47h${ESC}(B${ESC}[?47l${M}`],
    ['a shift after DECRC reloads from the slot, not the restored table', `${ESC}(0${ESC}7${ESC}(B${ESC}8${SI}${M}`],
    ['CSI ?2h resets the slots but leaves GL alone', `${ESC}(0${ESC}[?2h${M}`],
    ['CSI ?2h keeps a locked shift in place', `${ESC}n${ESC}[?2h${ESC}*0${M}`],
    ['RIS resets GL as well', `${ESC}n${ESC}c${ESC}*0${M}`],
    ['a multi-intermediate CSI is not DECSTR', `[bx:pr-${ESC}(0${ESC}[!!pfixed:tok123abc]`],
    ['a leading zero still names the mode', `${ESC}(0${ESC}[?1048h${ESC}(B${ESC}[?01048h${ESC}[?1048l${M}`],
    ['a sub-param does not change the primary', `${ESC}(0${ESC}[?1049:0h${ESC}(B${ESC}[?1049:0l${M}`],
    ['capacity counts parameters, not characters', `${ESC}(0${ESC}[?1048;1;2;3;4;5;6;7;8;9;10;11;12;13;14h${ESC}(B${ESC}[?1048;1;2;3;4;5;6;7;8;9;10;11;12;13;14l${M}`],
    ['a mode past the parameter capacity is dropped', `${ESC}(0${ESC}[?${Array.from({ length: 40 }, () => '1').join(';')};1048h${ESC}(B${M}`],
    ['a mode at parameter 11 is still within capacity', `${ESC}(0${ESC}[?1;2;3;4;5;6;7;8;9;10;1048h${ESC}(B${ESC}[?1;2;3;4;5;6;7;8;9;10;1048l${M}`],
    ['an out-of-range value names no mode', `${ESC}(0${ESC}[?10499999999h${ESC}(B${ESC}[?10499999999l${M}`],
    ['DEL inside the parameters does not become a digit', `${ESC}(0${ESC}[?10\x7f49h${ESC}(B${ESC}[?10\x7f49l${M}`],
    ['BEL inside the parameters does not become a digit', `${ESC}(0${ESC}[?10\x0749h${ESC}(B${ESC}[?10\x0749l${M}`],
    ['NUL inside the parameters does not become a digit', `${ESC}(0${ESC}[?10\x0049h${ESC}(B${ESC}[?10\x0049l${M}`],
    ['VT inside the parameters does not become a digit', `${ESC}(0${ESC}[?10\x0b49h${ESC}(B${ESC}[?10\x0b49l${M}`],
    ['HT inside the parameters does not become a digit', `${ESC}(0${ESC}[?10\x0949h${ESC}(B${ESC}[?10\x0949l${M}`],
    ['an unrecognised ESC % final leaves the old charset in place', `[bx:pr-${ESC}(0${ESC}%Xfixed:tok123abc]`],
    ['a digit ESC % final leaves the old charset in place', `[bx:pr-${ESC}(0${ESC}%0fixed:tok123abc]`],
    ['RIS clears the saved charset, so DECRC cannot bring it back', `${ESC}(0${ESC}7${ESC}c${ESC}8${M}`],
    ['DECSTR clears the saved charset too', `${ESC}(0${ESC}7${ESC}[!p${ESC}8${M}`],
    ['ESC %G selects the default without touching G1', `${ESC})0${ESC}%G${SO}${M}`],
    ['ESC %@ selects the default without touching G2', `${ESC}*0${ESC}%@${ESC}n${M}`],
    ['a GR designation still arms a later SO', `${ESC}-0${SO}${M}`],
    ['a GR designation still arms a later LS2', `${ESC}.0${ESC}n${M}`],
    ['ESC / is ignored, so LS3 finds nothing', `${ESC}/0${ESC}o${M}`],
    ['a multi-intermediate designation is ignored', `${ESC}(0${ESC}( F${M}`],
  ])('%s', async (_name, stream) => {
    const onScreen = MARKER_RE.test(compactSignalText(await screenText(stream)));
    expect(MARKER_RE.test(compactSignalText(visibleText(stream)))).toBe(onScreen);
  });
});
