import { describe, it, expect } from 'vitest';
import { hasRuntimeReadyView } from '../../src/agent/tmux.js';
import type { AgentRuntimeKind } from '../../src/agent/tmux.js';
import { classifyScreen, isTrustedIdleRule, manifests, MENU_RULE_IDS } from '../../src/agent/detect/classify.js';
import { blank, CC_NONYOLO_IDLE, CODEX_NONYOLO_IDLE, OC_NONYOLO_FRESH_IDLE, OC_YOLO_FRESH_IDLE, QODER_NONYOLO_FRESH_IDLE, QODER_YOLO_FRESH_IDLE, CC_NONYOLO_BASH_PERMISSION, CODEX_NONYOLO_ESCALATION, OC_NONYOLO_EXTERNAL_DIR_PERMISSION, QODER_NONYOLO_SHELL_PERMISSION } from './runtime-captures.js';

const busy = (screen: string, runtime: AgentRuntimeKind): boolean =>
  classifyScreen(runtime, screen).state === 'working';
const pendingBlocked = (screen: string, runtime: AgentRuntimeKind = 'claude-code'): boolean =>
  classifyScreen(runtime, screen).state === 'pending';
const overlay = (screen: string): boolean => classifyScreen('claude-code', screen).skipStateUpdate;

describe('gating policy rule-id references stay in sync with the manifests', () => {
  it('every menu rule id the gate references exists in that runtime manifest', () => {
    for (const [runtime, ids] of Object.entries(MENU_RULE_IDS) as Array<[AgentRuntimeKind, ReadonlySet<string>]>) {
      const declared = new Set(manifests[runtime].rules.map((rule) => rule.id));
      for (const id of ids) expect(declared.has(id), `${runtime}/${id}`).toBe(true);
    }
  });

  it('空屏幕 + 空标题在四份 manifest 上都不命中规则 —— waitSubmitAck 拿空屏幕做「只看标题」投影的前提', () => {
    for (const runtime of Object.keys(manifests) as AgentRuntimeKind[]) {
      expect(classifyScreen(runtime, '', '').matchedRuleId, runtime).toBeUndefined();
    }
  });

  it('the osc_title_idle id referenced by the title trust policy exists in every manifest that declares a title contract', () => {
    for (const runtime of ['claude-code', 'codex'] as const) {
      expect(manifests[runtime].rules.some((rule) => rule.id === 'osc_title_idle'), runtime).toBe(true);
    }
    expect(isTrustedIdleRule('claude-code', 'osc_title_idle')).toBe(true);
    expect(isTrustedIdleRule('codex', 'osc_title_idle')).toBe(false);
    expect(isTrustedIdleRule('codex', 'live_prompt_box')).toBe(true);
    expect(isTrustedIdleRule('codex', undefined)).toBe(false);
  });
});

describe('menu/select-form blockers gate dispatch as pending (was detectRuntimeMenu)', () => {
  const POSITIVE: Array<[string, string]> = [
    [
      'superpowers picker: "Enter to select · ↑/↓ to navigate · Esc to cancel"',
      '❯ 1. Subagent-Driven (Recommended)\n  2. Inline Execution\n  3. Type something.\n  4. Chat about this\nEnter to select · ↑/↓ to navigate · Esc to cancel\n',
    ],
    [
      'single-choice confirm anchor "Enter to confirm · Esc to cancel"',
      '> Apply this refactor?\nEnter to confirm · Esc to cancel\n',
    ],
  ];

  // herdr live_blocked_form 要求 'esc to cancel' 完整短语 + select 分支必须带导航短语;
  // 以下旧 baxian 宽判定形状在 herdr 边界下不再判 pending
  const HERDR_UNCOVERED: Array<[string, string]> = [
    [
      'overflow scroll-overlay mangles footer (truncated "cancel")',
      '❯ 1. post-approve-complete（推荐）\n  2. post-approve-fixed\n  3. 保持 pr-merge-ready 不变\n  4. Type something.\n  5. Chat about this\n─────────────────────────────────────────────────────\nEnter to sel Jump to bottom (ctrl+End) ↓ ate · Esc to\n',
    ],
    [
      'narrow pane truncates the footer tail "cancel"',
      '❯ 1. Yes\n  2. No\nEnter to select · ↑/↓ to navigate · Esc to\n',
    ],
    [
      'select footer without a navigation phrase',
      '  ❯ 1. Yes\n    2. No\n    Enter to select · Esc to cancel\n',
    ],
    [
      'agent prose mentioning the keys mid-sentence (no navigation phrase)',
      'Then hit Enter to select an option or Esc to cancel the dialog.\n',
    ],
  ];

  const NEGATIVE: Array<[string, string]> = [
    [
      'healthy REPL with user-typed prefill bracketed by dividers (claude no-footer menu shape)',
      '✻ Worked for 5m 38s\n────────────────────────────────────────────────────────────────────────────────\n❯ 按方案 A 开分支重构\n────────────────────────────────────────────────────────────────────────────────\n  Opus 4.7 [###############     ] 75%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n',
    ],
    [
      'real baxian-dev capture: idle claude REPL with prefilled draft "直接push" (regression)',
      '  Read 1 file\n\n⏺ 全部 review 处理完。汇总：\n\n✻ Worked for 33m 3s\n\n───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n❯ 直接push\n───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  Opus 4.7 [#################   ] 85%\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #101\n',
    ],
    [
      'numbered picker structure when footer hints are hidden',
      '❯ 1. Subagent-Driven (Recommended)\n  2. Inline Execution\n  3. Type something.\n',
    ],
    [
      'healthy ready REPL screen',
      '❯ Try "fix typecheck errors"\n⏵⏵ bypass permissions on (shift+tab to cycle)\n',
    ],
    [
      'healthy ready REPL screen with non-English prompt',
      '❯ 按方案 A 开分支重构\n⏵⏵ bypass permissions on (shift+tab to cycle)\n',
    ],
    [
      'ready REPL prompt after a single divider',
      '────────────────────────────────────────────────────────────────────────────────\n❯ 按方案 A 开分支重构\n⏵⏵ bypass permissions on (shift+tab to cycle)\n',
    ],
    [
      'markdown quote text bracketed by ASCII separators',
      '------------------------------------------------------------\n> quoted text from command output\n------------------------------------------------------------\n',
    ],
    [
      'numbered list typed at a ready REPL prompt',
      '❯ 1. Write a regression test\n  2. Run the relevant test\n  3. Push the branch\n⏵⏵ bypass permissions on (shift+tab to cycle)\n',
    ],
    [
      'blank lines collapsed into a fake divider-bracketed picker',
      '────────────────────────────────────────────────────────────────────────────────\n\n❯ 按方案 A 开分支重构\n\n────────────────────────────────────────────────────────────────────────────────\n',
    ],
    ['Auto-updating with Unicode ellipsis (startup-only signal)', 'status bar: Auto-updating…\n'],
    ['Auto-updating with version target', 'Auto-updating to v2.1.87'],
    [
      'busy "Esc to interrupt" with an unrelated "Enter to" on a different line (same-line rule)',
      '❯ press Enter to send a follow-up\n⏺ Thinking…\n  Esc to interrupt\n',
    ],
    [
      'keyboard help in prose/tool output — line does not START with "Enter to"',
      'Press Enter to continue, Esc to abort\n',
    ],
    [
      'line-start keyboard hint without the "·" footer separator (tool/TUI output)',
      'Enter to continue, Esc to abort\n',
    ],
    [
      'line-start keyboard hint, comma-joined (tool/TUI output)',
      'Enter to accept, Esc to skip\n',
    ],
  ];

  it('classifies every known runtime-menu anchor as pending', () => {
    for (const [name, screen] of POSITIVE) {
      expect.soft(pendingBlocked(screen), name).toBe(true);
    }
  });

  it('does NOT classify REPL chrome / unrelated text as pending', () => {
    for (const [name, screen] of NEGATIVE) {
      expect.soft(pendingBlocked(screen), name).toBe(false);
    }
  });

  it('herdr boundary: truncated/nav-less footer variants are no longer pending', () => {
    for (const [name, screen] of HERDR_UNCOVERED) {
      expect.soft(pendingBlocked(screen), name).toBe(false);
    }
  });
});

describe('hasRuntimeReadyView', () => {
  it('accepts a claude-code idle composer without the footer anchor', () => {
    expect(hasRuntimeReadyView('✻ Worked for 10s\n\n❯ \n', 'claude-code')).toBe(true);
  });

  it('rejects small-pane fallback when the visible pane is busy or waiting on a menu/dialog', () => {
    for (const [name, screen] of [
      ['busy spinner', '✽ Grooving… (5m 21s · thinking)\n\n❯ \n'],
      ['runtime menu', '❯ \nEnter to select · ↑/↓ to navigate · Esc to cancel\n'],
      ['startup dialog', '❯ \nPress enter to continue\n'],
      ['trust dialog', 'Quick safety check\n❯ 1. Yes, I trust this folder\n'],
    ] as Array<[string, string]>) {
      expect.soft(hasRuntimeReadyView(screen, 'claude-code'), name).toBe(false);
    }
  });

  it('herdr flip: a narrow-wrapped transcript footer without the phrase in the bottom window no longer blocks the boxed composer', () => {
    const screen = 'transcript body\n────────────────\n❯ \n────────────────\nctrl+o to toggle · esc to\nclose\n';
    expect(hasRuntimeReadyView(screen, 'claude-code')).toBe(true);
  });

  it('rejects claude-code when a spinner sits above a blank sea (tailNonEmpty window counts non-empty lines, herdr-style)', () => {
    const lines = [
      '✽ Grooving… (5m 21s · thinking)',
      ...blank(18),
      '❯ ',
      '',
    ];
    expect(hasRuntimeReadyView(lines.join('\n'), 'claude-code')).toBe(false);
  });

  it('does not apply the claude small-pane fallback to codex', () => {
    expect(hasRuntimeReadyView('❯ \n', 'codex')).toBe(false);
  });

  it('accepts codex idle prompt with → arrow', () => {
    expect(hasRuntimeReadyView('→ baxian git:(main)\n', 'codex')).toBe(true);
  });

  it('accepts a bare › as codex idle (a cleared empty composer; busy/menu gating still applies)', () => {
    expect(hasRuntimeReadyView('› \n', 'codex')).toBe(true);
  });

  it('reads the codex pinned composer as idle once the styled blank rows arrive trimmed', () => {
    const screen = '─ Worked for 9m 16s ───────\n\n\n'
      + '› Ask Codex to do anything\n\n'
      + '  gpt-5.6-sol xhigh · ~/.baxian/agents/qa/repo\n';
    expect.soft(classifyScreen('codex', screen).state).toBe('idle');
    expect.soft(hasRuntimeReadyView(screen, 'codex')).toBe(true);
  });

  it('treats a claude-styled spinner above the codex prompt as stale (codex working detection rides the OSC title)', () => {
    const screen = '· Thinking… (5s)\n→ baxian git:(main)\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(true);
  });

  it('accepts codex → prompt when stale esc-to-interrupt is ABOVE the prompt', () => {
    const screen = 'Working on it…\n  esc to interrupt\n→ baxian git:(main)\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(true);
  });

  it('rejects codex → prompt when esc-to-interrupt is BELOW the prompt (active busy)', () => {
    const screen = '→ baxian git:(main)\nWorking on it…\n  esc to interrupt\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(false);
  });

  it('rejects codex → prompt when Working(...) is active in tail', () => {
    const screen = '→ baxian git:(main)\n• Working (8s)\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(false);
  });

  it('does not accept → output line (e.g. → run tests) as codex idle prompt', () => {
    expect(hasRuntimeReadyView('→ run tests\n', 'codex')).toBe(false);
  });

  it('does not accept indented → line as codex idle prompt', () => {
    expect(hasRuntimeReadyView('  → baxian git:(main)\n', 'codex')).toBe(false);
  });

  it('rejects codex → prompt when output follows it', () => {
    expect(hasRuntimeReadyView('→ baxian git:(main)\nStill working on the request...\n', 'codex')).toBe(false);
  });

  it('accepts codex backtrack hint footer (Esc on empty composer) as idle/ready', () => {
    const screen =
      '─ Worked for 1m 14s ─────────────────\n\n' +
      '› Use /skills to list available skills\n\n' +
      '  esc again to edit previous message\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(true);
  });

  it('only treats the backtrack hint as ready when it is the bottom footer (busy marker below → not ready)', () => {
    const screen =
      '› Use /skills to list available skills\n\n' +
      '  esc again to edit previous message\n' +
      '· Working (8s)\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(false);
  });

  it('does not treat the backtrack hint as ready for claude-code', () => {
    expect(hasRuntimeReadyView('  esc again to edit previous message\n', 'claude-code')).toBe(false);
  });

  it('opencode: idle composer footer without busy signals is ready', () => {
    expect(hasRuntimeReadyView('┃  Build auto · Zen\n   8.3K (4%)  ctrl+p commands\n', 'opencode')).toBe(true);
  });

  it('opencode: a working screen (progress bar + esc interrupt) is not ready', () => {
    expect(hasRuntimeReadyView('   ■■■⬝⬝⬝  esc interrupt          ctrl+p commands\n', 'opencode')).toBe(false);
  });

  it('qodercli: idle composer placeholder is ready', () => {
    expect(hasRuntimeReadyView('*   Type your message or @path/to/file\n', 'qodercli')).toBe(true);
  });

  it('qodercli: a thinking spinner screen is not ready', () => {
    expect(hasRuntimeReadyView('⠼ Thinking... (esc to cancel, 3s)\n', 'qodercli')).toBe(false);
  });

  it('opencode: a permission prompt that keeps the idle footer is not ready', () => {
    expect(hasRuntimeReadyView('△ Permission required\n  Allow once   Reject\n  ctrl+p commands\n', 'opencode')).toBe(false);
  });

  it.each([
    'Permission Required',
    'allow once or always?',
    'asking user',
    'enter your response',
    'review your answers:',
    'shell awaiting input',
  ])('qodercli: pending prompt %j keeping the composer is not ready', (prompt) => {
    expect(hasRuntimeReadyView(`${prompt}\n  Type your message or @path\n`, 'qodercli')).toBe(false);
  });

  // herdr 边界:这些短语不在 herdr confirmation_or_input_blocker 集合内,或要求同时出现选项词
  it.each([
    'Allow this command to run?',
    'Do you want to allow this read?',
    'waiting for user confirmation',
    'awaiting approval',
  ])('qodercli herdr boundary: %j alone (no herdr option words) no longer blocks ready', (prompt) => {
    expect(hasRuntimeReadyView(`${prompt}\n  Type your message or @path\n`, 'qodercli')).toBe(true);
  });

  it('qodercli: a shortcuts/help overlay is not ready (footer alone is not an idle cue)', () => {
    expect(hasRuntimeReadyView('  keyboard shortcuts\n  ? for shortcuts\n', 'qodercli')).toBe(false);
  });
});

describe('working-state gating (was runtimeBusyCheck, opencode/qodercli screen-only busy)', () => {
  it('opencode: esc interrupt hint is busy', () => {
    expect(busy('   ■■■⬝⬝⬝  esc interrupt\n', 'opencode')).toBe(true);
  });

  it('opencode: idle composer is not busy', () => {
    expect(busy('┃  Build auto · Zen\n   8.3K (4%)  ctrl+p commands\n', 'opencode')).toBe(false);
  });

  it('qodercli: "(esc to cancel," spinner is busy', () => {
    expect(busy('⠼ Thinking... (esc to cancel, 3s)\n', 'qodercli')).toBe(true);
  });

  it('qodercli: idle composer is not busy', () => {
    expect(busy('*   Type your message or @path/to/file\n', 'qodercli')).toBe(false);
  });

  it('opencode: ctrl+c interrupt hint alone (progress bar wrapped out of tail) is busy', () => {
    expect(busy('running a long tool call\n  ctrl+c to interrupt          ctrl+p commands\n', 'opencode')).toBe(true);
  });

  it('opencode: uppercase "ESC to interrupt" is busy (case-insensitive contains)', () => {
    expect(busy('long tool output\n  ESC to interrupt\n', 'opencode')).toBe(true);
  });

  it('qodercli: braille spinner with non-ASCII activity text is busy', () => {
    expect(busy('⠼ 正在思考中...\n', 'qodercli')).toBe(true);
  });
});

describe('working-state gating (herdr whole_recent = 整屏,陈旧 hint 不再随窗口滚出)', () => {
  it('opencode: a stale interrupt hint far above a current composer stays working (herdr flip)', () => {
    const screen = [
      '  ctrl+c to interrupt',
      ...Array.from({ length: 12 }, (_, i) => `done line ${i}`),
      '   8.3K (4%)  ctrl+p commands',
    ].join('\n');
    expect(busy(screen, 'opencode')).toBe(true);
    expect(hasRuntimeReadyView(screen, 'opencode')).toBe(false);
  });

  it('qodercli: a stale spinner line far above a current composer stays working (herdr flip)', () => {
    const screen = [
      ' ⠼ Thinking... (esc to cancel, 3s)',
      ...Array.from({ length: 12 }, (_, i) => `done ${i}`),
      ' >   Type your message or @path/to/file',
    ].join('\n');
    expect(busy(screen, 'qodercli')).toBe(true);
    expect(hasRuntimeReadyView(screen, 'qodercli')).toBe(false);
  });
});

describe('working-state gating (position-aware)', () => {
  it('codex: stale esc-to-interrupt above → prompt is NOT busy (position-aware)', () => {
    const screen = 'Working on it…\n  esc to interrupt\n→ baxian git:(main)\n';
    expect(busy(screen, 'codex')).toBe(false);
  });

  it('codex: a plain esc-to-interrupt line is not a herdr codex working signal (working rides the OSC title / • Working shape)', () => {
    const screen = '→ baxian git:(main)\nWorking on it…\n  esc to interrupt\n';
    expect(busy(screen, 'codex')).toBe(false);
  });

  it('claude-code: spinner above a blank sea IS busy (non-empty window, blanks cannot push the spinner out)', () => {
    const lines = [
      '✽ Grooving… (5m 21s · thinking)',
      ...blank(18),
      '❯ ',
      '',
    ];
    expect(busy(lines.join('\n'), 'claude-code')).toBe(true);
  });

  it('codex: same tall-pane spinner is NOT busy (position-aware only checks tail)', () => {
    const lines = [
      '✽ Grooving… (5m 21s · thinking)',
      ...blank(18),
      '→ baxian git:(main)',
      '',
    ];
    expect(busy(lines.join('\n'), 'codex')).toBe(false);
  });
});

describe('hasRuntimeReadyView accepts a cleared bare Codex › only when nothing runtime-owned is on screen', () => {
  it('treats a bare › (only blank lines below) as a ready idle composer', () => {
    expect(hasRuntimeReadyView('› \n', 'codex')).toBe(true);
    expect(hasRuntimeReadyView('output scrolled up\n›\n\n', 'codex')).toBe(true);
  });
  it('accepts an INDENTED bare › — Codex indents the empty prompt marker', () => {
    expect(hasRuntimeReadyView('  › \n', 'codex')).toBe(true);
    expect(hasRuntimeReadyView('prior output\n  ›\n', 'codex')).toBe(true);
  });
  it('treats working chrome ABOVE a bare › as stale (codex working detection rides the OSC title)', () => {
    expect(hasRuntimeReadyView('· Working… (12s)\n  esc to interrupt\n› \n', 'codex')).toBe(true);
  });
  it('still rejects a confirm-footer blocker above a bare › (native dialog guard)', () => {
    expect(hasRuntimeReadyView('Allow command `rm`?\n  Press Enter to confirm or Esc to cancel\n› \n', 'codex')).toBe(false);
  });
  it('does NOT treat a node/shell > as a Codex composer', () => {
    expect(hasRuntimeReadyView('> require("fs")\n> \n', 'codex')).toBe(false);
  });

  it('does NOT treat a bare › as ready when ordinary user text follows it (pasted/leftover transcript)', () => {
    expect(hasRuntimeReadyView('›\nplease finish the refactor\n', 'codex')).toBe(false);
    expect(hasRuntimeReadyView('some output\n›\nleftover line\n  gpt-5.5 xhigh · ~/repo\n', 'codex')).toBe(false);
  });
  it('does NOT treat a bare › with a status footer DIRECTLY below it as empty (that shape is the with-text form)', () => {
    expect(hasRuntimeReadyView('› \n  gpt-5.5 xhigh · ~/repo\n', 'codex')).toBe(false);
    expect(hasRuntimeReadyView('› \n  gpt-5.5 xhigh · /Users/x/repo\n', 'codex')).toBe(false);
  });
  it('does NOT treat a › followed by a dirty/non-blank line then a footer as ready', () => {
    expect(hasRuntimeReadyView('›\nold output\n› new dirty prompt text\n  gpt-5.5 xhigh · ~/repo\n', 'codex')).toBe(false);
    expect(hasRuntimeReadyView('›\n  see logs · /tmp/out and fix it\n', 'codex')).toBe(false);
    expect(hasRuntimeReadyView('›\n  - refactor auth · update tests · ship\n  gpt-5.5 xhigh · ~/repo\n', 'codex')).toBe(false);
  });
});

describe('non-yolo & fresh-screen geometry (real captures)', () => {
  it.each([
    ['claude-code non-yolo idle (❯ + NBSP composer)', CC_NONYOLO_IDLE, 'claude-code'],
    ['codex non-yolo idle (generic footer anchor)', CODEX_NONYOLO_IDLE, 'codex'],
    ['opencode non-yolo fresh idle (footer above blank sea)', OC_NONYOLO_FRESH_IDLE, 'opencode'],
    ['opencode --auto fresh idle', OC_YOLO_FRESH_IDLE, 'opencode'],
    ['qodercli non-yolo fresh idle (top-anchored, 34 trailing blanks)', QODER_NONYOLO_FRESH_IDLE, 'qodercli'],
    ['qodercli --dangerously-skip-permissions fresh idle', QODER_YOLO_FRESH_IDLE, 'qodercli'],
  ] as const)('%s is ready and not busy', (_name, screen, runtime) => {
    expect(busy(screen, runtime)).toBe(false);
    expect(hasRuntimeReadyView(screen, runtime)).toBe(true);
  });

  it.each([
    ['claude-code bash permission prompt', CC_NONYOLO_BASH_PERMISSION, 'claude-code'],
    ['codex escalation prompt', CODEX_NONYOLO_ESCALATION, 'codex'],
    ['opencode external-directory permission prompt', OC_NONYOLO_EXTERNAL_DIR_PERMISSION, 'opencode'],
    ['qodercli shell permission prompt', QODER_NONYOLO_SHELL_PERMISSION, 'qodercli'],
  ] as const)('%s blocks the ready gate', (_name, screen, runtime) => {
    expect(hasRuntimeReadyView(screen, runtime)).toBe(false);
  });

  it('opencode: busy bar above the blank sea is still busy', () => {
    const screen = ['  ┃  ■■■■⬝⬝⬝⬝  esc interrupt', ...blank(12), '  /w  1.17.17'].join('\n');
    expect(busy(screen, 'opencode')).toBe(true);
  });

  it('qodercli: spinner above 34 trailing blank rows is still busy', () => {
    const screen = [' ⠼ Thinking... (esc to cancel, 3s)', ...blank(34)].join('\n');
    expect(busy(screen, 'qodercli')).toBe(true);
  });
});

describe('osc title classification (engine arbitration + gating trust policy)', () => {
  it.each([
    ['claude-code idle title with task summary', '✳ 分析 baxian 服务', 'claude-code' as const, true],
    ['claude-code idle title without a task yet', '✳ Claude Code', 'claude-code' as const, true],
    ['braille spinner prefix means working, not idle', '⠹ 分析 baxian 服务', 'claude-code' as const, false],
    ['empty title (pane_title unavailable)', '', 'claude-code' as const, false],
    ['✳ without the following space is not the idle contract', '✳分析', 'claude-code' as const, false],
    ['codex cwd-shaped title has no idle contract for dispatch gating', 'baxian', 'codex' as const, false],
    ['codex: even a ✳-prefixed title is not a gating idle signal', '✳ x', 'codex' as const, false],
    ['opencode title has no idle contract', 'OC | some session', 'opencode' as const, false],
    ['qodercli Ready title is not an idle signal (shown while working too)', '◇  Ready (repo)', 'qodercli' as const, false],
  ])('%s → %s', (_label, title, runtime, expected) => {
    expect(hasRuntimeReadyView('', runtime, classifyScreen(runtime, '', title))).toBe(expected);
  });

  it('braille titles classify as working for every runtime that declares the contract', () => {
    expect(classifyScreen('claude-code', '', '⠁ Reading file').state).toBe('working');
    expect(classifyScreen('claude-code', '', '⣿ Working').state).toBe('working');
    expect(classifyScreen('codex', '', '⠙ Reading file').state).toBe('working');
  });

  it('codex herdr spinner set is the 10 dots1 frames — other braille chars are idle evidence', () => {
    expect(classifyScreen('codex', '', '⠁ Reading file').state).toBe('idle');
  });

  it('does NOT classify an idle/non-spinner title or a bare proc name as working', () => {
    for (const title of ['baxian · main', '✳ idle', 'node', '', '⠁no-space-after-spinner']) {
      expect.soft(classifyScreen('claude-code', '', title).state, title).not.toBe('working');
    }
  });

  it('codex Action Required title classifies as pending', () => {
    expect(classifyScreen('codex', '', 'Action Required · baxian').state).toBe('pending');
  });
});

describe('pending-prompt gating (was detectRuntimePendingPrompt)', () => {
  it.each([
    ['bash permission prompt', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n', true],
    ['legacy waiting-for-permission', 'Waiting for permission…\n', true],
    ['connection allow prompt', 'Do you want to allow this connection?\n1. Yes\n', true],
    ['select-option footer without a navigation phrase (herdr boundary)', 'Enter to select ·\nEsc to cancel\n', false],
    ['dynamic workflow prompt', 'Run a dynamic workflow?\nEnter to run · Esc to cancel\n', true],
    ['bash amend footer with option lines', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\ntab to amend · esc to cancel\n', true],
    ['explain footer with option lines', 'rm -rf build\n❯ 1. Yes\nctrl+e to explain this command\n', true],
    ['offer with a numbered Yes option line', 'Would you like to create a plan?\n❯ 1. Yes\n  2. No\n', true],
    ['offer with a selected non-yes option line', 'Do you want to continue?\n❯ 2. No, cancel\n', true],
    ['offer with bare unnumbered Yes options (inverse-video selection, no ❯ after stripAnsi)', 'Do you want to proceed?\nYes\nNo\n', true],
    ['offer with a bare Yes-and-dont-ask variant', "Do you want to proceed?\nYes, and don't ask again\nNo\n", true],
    ['offer with only a numbered No option (herdr legacy needs a yes/❯ token)', 'Do you want to proceed?\n  2. No\n', false],
    ['bare yes at line start in prose without an offer phrase', 'yes 分支的判定已经覆盖。\n', false],
    ['plan-mode review prompt', 'Review your answers\n', true],
    ['skip-interview prompt', 'Skip interview and plan immediately\n', true],
    ['narrow-wrapped confirm footer (enter to confirm)', '确认删除分支？\nEnter to confirm ·\nEsc to cancel\n', true],
    ['narrow-wrapped skip-interview phrase broken across lines (herdr contains is not wrap-aware)', 'Skip interview and plan\nimmediately\n', false],
    ['narrow-wrapped offer phrase broken across lines (herdr contains is not wrap-aware)', 'Would you like\nto apply this plan?\n❯ 1. Yes\n  2. No\n', false],
    ['herdr flip: a quoted offer phrase plus any ❯ token satisfies the legacy blocker', '表单文案是 "Would you like to apply?"。\n❯ run tests\n', true],
    ['offer phrase alone in prose (no option line)', 'Would you like me to proceed with the merge?\n', false],
    ['proceed question quoted in prose (no option line)', '日志里出现 Do you want to proceed? 即为权限提示。\n', false],
    ['herdr flip: tab-to-amend is a standalone legacy blocker branch, prose included', '权限表单支持 tab to amend 快捷键。\n', true],
    ['dynamic workflow phrase in prose (no esc to cancel)', '我加了 run a dynamic workflow? 的检测。\n', false],
    ['enter-to-select alone in prose (no esc to cancel)', '在 TUI 里 enter to select 表示确认当前项。\n', false],
    ['plain idle composer tail', '✻ Worked for 31s\n\n❯ \n⏵⏵ bypass permissions on\n', false],
    ['phrase without option lines high above the composer', 'do you want to proceed?\n' + 'x\n'.repeat(16) + '❯ \n', false],
    [
      'tall permission form: offer above the 15-line tail but inside the active form region',
      '正文历史\n' + '─'.repeat(40) + '\nWould you like to apply this plan?\n' + 'plan detail\n'.repeat(16) + '❯ 1. Yes\n  2. No\n',
      true,
    ],
    [
      'prose mention above the composer box rule is outside the active form region',
      'Do you want to proceed? 的检测已补充。\n' + '─'.repeat(40) + '\n❯ \n' + '─'.repeat(40) + '\n  ⏵⏵ bypass permissions on\n',
      false,
    ],
  ])('%s → %s', (_label, screen, expected) => {
    expect(pendingBlocked(screen)).toBe(expected);
  });
});

describe('overlay gating (was detectRuntimeOverlay, now skipStateUpdate; herdr transcript = 短语+footer 同窗)', () => {
  it.each([
    ['transcript phrase + footer in the bottom window', 'transcript body\nShowing detailed transcript\nctrl+o to toggle\n', true],
    ['transcript phrase + scroll hint footer', 'transcript body\nShowing detailed transcript\n↑↓ scroll\n', true],
    ['model picker menu (full herdr footer)', 'Select model\n❯ 1. Fable\n  2. Opus\nenter to set as default · esc to cancel\n', true],
    ['herdr boundary: footer alone without the transcript phrase', '  transcript line\n\nctrl+o to toggle · esc to close\n', false],
    ['herdr boundary: wrapped footer without the phrase', 'transcript line\nctrl+o to toggle · esc to\nclose\n', false],
    ['herdr boundary: wrapped phrase without a footer', 'Showing detailed\ntranscript\n', false],
    ['herdr boundary: phrase alone without a footer', 'Showing detailed transcript\n', false],
    ['herdr boundary: scroll hint alone', 'some output\n↑↓ scroll · q quit\n', false],
    ['herdr boundary: collapse hint alone', 'ctrl+e collapse view\n', false],
    ['herdr boundary: picker without esc to cancel', 'Select model\n❯ 1. Fable\n  2. Opus\nenter to set as default\n', false],
    ['normal idle footer', '✻ Worked for 31s\n\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)\n', false],
    ['ctrl+o mentioned mid-text, above the 2-line footer window', 'ctrl+o to toggle 是转录视图快捷键。\n正文继续。\n结论：已覆盖。\n', false],
    ['select model mentioned without the set-as-default footer', '我用 /model 打开 select model 菜单做了对比。\n', false],
  ])('%s → %s', (_label, screen, expected) => {
    expect(overlay(screen)).toBe(expected);
  });
});

describe('launch composer cues (was hasRuntimeIdleComposerPrompt; herdr manifest 无 composer idle 规则,生命周期就绪走 native 线索)', () => {
  it('detects codex → prompt in tail', () => {
    const screen = 'some output\n→ baxian git:(main)\n';
    expect(hasRuntimeReadyView(screen, 'codex')).toBe(true);
  });

  it('detects codex → prompt without git info', () => {
    expect(hasRuntimeReadyView('→ myproject\n', 'codex')).toBe(true);
  });

  it('matches a bare › empty composer — only blank lines may follow (col-0 OR indented marker)', () => {
    expect(hasRuntimeReadyView('› \n', 'codex')).toBe(true);
    expect(hasRuntimeReadyView('  ›\n', 'codex')).toBe(true);
    expect(hasRuntimeReadyView('old output\n  ›\n\n', 'codex')).toBe(true);
    expect(hasRuntimeReadyView('› with text\n', 'codex')).toBe(false);
    expect(hasRuntimeReadyView('› \n  gpt-5.5 xhigh · ~/repo\n', 'codex')).toBe(false);
  });

  it('a bare › is empty only when ONLY blank lines follow — any non-blank line below means dirty', () => {
    expect(hasRuntimeReadyView('›\nleftover user text\n', 'codex')).toBe(false);
    expect(hasRuntimeReadyView('›\nold output\n› still typing\n', 'codex')).toBe(false);
    expect(hasRuntimeReadyView('› old typing\n  wrapped\n  ›\n', 'codex')).toBe(true);
  });

  it('does not match → followed by multi-word content (output, not prompt)', () => {
    expect(hasRuntimeReadyView('→ run tests now\n', 'codex')).toBe(false);
  });

  it('does not match → prompt when output follows it', () => {
    expect(hasRuntimeReadyView('→ baxian git:(main)\nStill working on the request...\n', 'codex')).toBe(false);
  });

  it('rejects codex when prompt is not in tail', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    lines[0] = '→ baxian git:(main)';
    expect(hasRuntimeReadyView(lines.join('\n'), 'codex')).toBe(false);
  });

  it('still works for claude-code', () => {
    expect(hasRuntimeReadyView('❯ \n', 'claude-code')).toBe(true);
  });
});

describe('active-busy gating for claude (was detectReplActiveBusy / hasActiveSpinner*)', () => {
  const STATUS_TAIL = [
    '────────────────────────────────────────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────────────────────────────────────────',
    '  Opus 4.7 [#################   ] 87%',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');

  const POSITIVE: Array<[string, string]> = [
    ['live spinner with interrupt suffix', '· Stewing… (24s · esc to interrupt)'],
    ['live spinner in middle of viewport (m+s elapsed)', '❯ user prompt\n\n· Wrangling… (2m 42s)\n\n' + STATUS_TAIL],
    ['⏸⏵ status line with esc to interrupt on the same line', '⏵ Thinking · esc to interrupt'],
    ['spinner above blank rows with only the composer below (non-empty window keeps it busy)', ['· Wrangling… (24s · esc to interrupt)', ...blank(12), '❯ '].join('\n')],
    ['spinner in the activity region just above the footer', [
      '· Wrangling… (42s · esc to interrupt)',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  Opus 4.7 [#################   ] 87%',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')],
  ];

  // herdr live_turn 只认「spinner 字符 + …(Ns + 空格/·」与「⏸⏵ 同行 esc to interrupt」两种形状;
  // 旧 baxian 的裸 (Ns) 与跨行 esc-to-interrupt 判定不在其中
  const HERDR_UNCOVERED: Array<[string, string]> = [
    ['bare (Ns) spinner without a suffix', '· Stewing… (24s)'],
    ['esc to interrupt on its own line', 'Working on it…\n  esc to interrupt'],
    ['early-thinking with Esc to interrupt on a separate line', '⏵ Thinking…\n\n  Esc to interrupt'],
  ];

  const NEGATIVE: Array<[string, string]> = [
    ['idle REPL prompt', '⏵⏵ bypass permissions on ~/code\n\n>'],
    [
      'history mentions `esc to interrupt` phrase but runtime is idle (regression: was busy under detectBusy)',
      [
        '⏺ 之前讨论过：detectBusy 用字面 "esc to interrupt" 匹配，会被历史误报。',
        '',
        '所以现在改用 spatial-scoped detector，把这个 phrase 的判定限制到 viewport 底部状态区。',
        '',
        '✻ Worked for 5m 38s',
        '',
        STATUS_TAIL,
      ].join('\n'),
    ],
    [
      'user prompt quotes "Esc to interrupt" (case-insensitive) but pane is idle',
      [
        '❯ 请解释 Esc to interrupt 在 Claude Code 状态条下方什么时候显示',
        '',
        '✻ Worked for 12s',
        '',
        STATUS_TAIL,
      ].join('\n'),
    ],
    ['spinner-shaped line in history with subsequent Worked for marker', '· Wrangling… (24s)\n\n✻ Worked for 24s\n\n' + STATUS_TAIL],
    ['spinner-shaped line already completed (Worked for marker after)', '· Wrangling… (24s)\n\n✻ Worked for 24s\n'],
    ['empty string', ''],
  ];

  it('classifies every active-task signal as working', () => {
    for (const [name, screen] of POSITIVE) {
      expect.soft(busy(screen, 'claude-code'), name).toBe(true);
    }
  });

  it('herdr boundary: shapes outside the herdr live_turn grammar are not working', () => {
    for (const [name, screen] of HERDR_UNCOVERED) {
      expect.soft(busy(screen, 'claude-code'), name).toBe(false);
    }
  });

  it('rejects idle / history-only / quoted-text false positives', () => {
    for (const [name, screen] of NEGATIVE) {
      expect.soft(busy(screen, 'claude-code'), name).toBe(false);
    }
  });
});

describe('hasRuntimeReadyView 尊重完整判定:native 线索只能作为 idle 的正证据', () => {
  const CC_YOLO_TAIL = '⏺ 输出\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)\n';
  const CODEX_YOLO_TAIL = 'permissions: YOLO mode\n› \n';

  it('claude: bypass 页脚不得压过 working 的 OSC 标题', () => {
    const detection = classifyScreen('claude-code', CC_YOLO_TAIL, '⠧ thinking');
    expect(detection.state).toBe('working');
    expect(hasRuntimeReadyView(CC_YOLO_TAIL, 'claude-code', detection)).toBe(false);
  });

  it('codex: YOLO 横幅不得压过 Action Required 标题', () => {
    const detection = classifyScreen('codex', CODEX_YOLO_TAIL, 'Action Required · baxian');
    expect(detection.state).toBe('pending');
    expect(hasRuntimeReadyView(CODEX_YOLO_TAIL, 'codex', detection)).toBe(false);
  });

  it('claude: 完整判定为 idle 时 bypass 页脚仍是正就绪证据', () => {
    expect(hasRuntimeReadyView(CC_YOLO_TAIL, 'claude-code')).toBe(true);
  });

  it('codex: 空 › composer 仍能救回不受信的 idle 标题', () => {
    expect(hasRuntimeReadyView('› \n', 'codex', classifyScreen('codex', '› \n', 'baxian'))).toBe(true);
  });
});
