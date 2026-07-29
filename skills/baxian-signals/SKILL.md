---
name: baxian-signals
description: How an agent signals baxian server back through its pane — format, substitution rule, signal catalog. Consult whenever a dispatch prompt or skill tells you to emit a `[bx:...]` signal.
---

This is the single source of truth for how an agent talks back to baxian server. Every dispatch prompt and every other baxian skill that tells you to "emit a signal" follows this protocol.

## Channel

Emit signals in your **assistant reply text**, on a line of their own. NOT via `echo`/`printf` in a Bash tool: the runtime's TUI captures Bash stdout, so it never reaches the pane baxian watches — a printed signal is invisible to the server.

baxian scans the pane fuzzily (strips ANSI escapes and whitespace), so a TUI soft-wrap inside a signal still matches.

## Format

- Two-segment: `[bx:KIND:TOKEN]` — for kinds with no payload.
- Actor form: `[bx:KIND:<pr_number>:<base64url-actor-id>:TOKEN]` — KIND is `pr-created` or `spec-done`. Both kinds MUST carry the selected PR and platform account id computed by your `baxian-cli-<tool>` skill §Create; omitting the actor prevents feedback acknowledgements from being authorized.

If your runtime's TUI renders assistant markdown and would turn a bare `[bx:...]` into a link — dropping the square brackets from what baxian captures — wrap the signal in inline-code backticks so the brackets survive to the pane: `` `[bx:KIND:TOKEN]` ``. Backticks are always safe to add, so when in doubt wrap every signal.

## How to emit

For task completion, select KIND by the dispatch's `phase:` and the exit section completed in its phase skill:

| Phase | Exit | KIND |
|---|---|---|
| `develop` | `§Deliver` | `pr-created` |
| `develop` | `§SDD` | `spec-done` |
| `code` | `§Deliver` | `pr-created` |
| `fix` | `§Fix` | `pr-fixed` |
| `post-approve` | `§Post-Approve` | `pr-merge-ready` |

The descriptor supplies the rotating `token:` only. A phase skill may expose multiple exits; emit the kind for the route you actually completed, never both.

1. Build the wire form `[bx:KIND:TOKEN]` with the selected KIND and the descriptor's TOKEN. A kind that carries a PR number (see Format) takes the number of the PR created or published by the current phase's instructions; the descriptor has no PR-number field.
2. Emit the filled signal **alone on its own line**.
3. **Never emit an angle-bracket placeholder** like `[bx:pr-fixed:<token>]` verbatim — the scanner's strict regex cannot match placeholders, so it fires nothing and the task hangs forever waiting on a signal.
4. Emit **exactly once**, only when the route's precondition holds. The token rotates every dispatch, so a stale or guessed token never fires.

## Signal catalog

Phase signals — the per-dispatch transition signals baxian consumes to advance a task. The route table and phase skill together define which one to emit and when.

Bootstrap handshake (before any task):

| Signal | Meaning |
|---|---|
| `greeting` | one-time capability check at agent startup; prove you can load this skill and signal back. baxian holds the agent until it sees a valid `greeting` echo |

PR flow:

| Signal | Meaning |
|---|---|
| `pr-created` (+PR# and actor with `cli:`) | code is ready on the selected PR; hand off to QA code review |
| `pr-fixed` | dev addressed all review feedback |
| `pr-merge-ready` | post-approve feedback handled clean; safe to merge |

QA verdicts are not signals: they travel only as platform review comments carrying the paired verdict tokens, per your `baxian-cli-<tool>` skill §Verdict.

SDD spec flow:

| Signal | Meaning |
|---|---|
| `spec-done` (+PR# and actor) | spec is ready on the selected PR |

## Need-input side-channel

A paired ask/answer protocol. Neither signal consumes the phase-signal watch or advances the task.

**Ask** — when you ask your human partner a question and pause for their answer, also emit, on its own line:

```
[bx:need-input:<token>:<n>]
```

`<token>` is the current dispatch's `token:` value; `<n>` is the question's ordinal within this dispatch — 1 for your first question, incremented by 1 for every later one (also when re-asking the same question). baxian shows a waiting badge in its UI so the user knows to open your terminal.

**Answer received** — when the answer arrives (typed reply, or an AskUserQuestion tool result), emit at the earliest point of your next output, on its own line, with the SAME `<n>` as the question it answers:

```
[bx:input-received:<token>:<n>]
```

This clears the waiting badge for every reply path (web terminal, external `tmux attach`, single-key picker choices alike). The badge also clears when the user submits input through baxian's web terminal, and at the latest when your next phase signal fires — but the paired confirm is what keeps it accurate, so emit it every time.

Keep the ordinals honest and monotonic: baxian ignores replayed or out-of-order ordinals, so a wrong `<n>` can only delay the badge, never corrupt it.
