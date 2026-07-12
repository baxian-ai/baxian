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
- Three-segment: `[bx:pr-created:<pr_number>:TOKEN]` — `pr-created` always carries the PR number; `code-ready` may carry it (publish-as-PR).

If your runtime's TUI renders assistant markdown and would turn a bare `[bx:...]` into a link — dropping the square brackets from what baxian captures — wrap the signal in inline-code backticks so the brackets survive to the pane: `` `[bx:KIND:TOKEN]` ``. Backticks are always safe to add, so when in doubt wrap every signal.

## How to emit

The dispatch descriptor names the signal kind in a signal field and the token in `token:`. The default completion field is `signal:`; some phases add an alternate field for an optional branch (e.g. `spec-signal:` on develop's SDD route). Your phase skill's flow tells you which field applies — emit the one for the route you took, never both:

```
signal: pr-fixed
token: a1b2c3d4e5f6
```

1. Build the wire form `[bx:KIND:TOKEN]` — KIND = the selected field's value, TOKEN = the `token:` value. A kind that carries a PR number (see Format) takes the number of the PR you just created with `gh pr create`; the descriptor has no PR-number field.
2. Emit the filled signal **alone on its own line**.
3. **Never emit an angle-bracket placeholder** like `[bx:pr-fixed:<token>]` verbatim — the scanner's strict regex cannot match placeholders, so it fires nothing and the task hangs forever waiting on a signal.
4. Emit **exactly once**, only when the route's precondition holds. The token rotates every dispatch, so a stale or guessed token never fires.

## Signal catalog

Phase signals — the per-dispatch transition signals baxian consumes to advance a task. The dispatch prompt always names which one to emit and when.

Bootstrap handshake (before any task):

| Signal | Meaning |
|---|---|
| `greeting` | one-time capability check at agent startup; prove you can load this skill and signal back. baxian holds the agent until it sees a valid `greeting` echo |

GitHub PR flow:

| Signal | Meaning |
|---|---|
| `pr-created` (+PR#) | dev opened the PR; hand off to QA review |
| `pr-approved` | QA approves — 422 fallback only; the native path is `gh pr review --approve` |
| `pr-changes-requested` | QA requests changes — 422 fallback only |
| `pr-fixed` | dev addressed all review feedback |
| `pr-merge-ready` | post-approve feedback handled clean; safe to merge |

SDD spec flow:

| Signal | Meaning |
|---|---|
| `spec-done` | dev wrote `.baxian/spec.md`; request QA spec review |

Server review flow (no PR; exchange via `.baxian/review/*.json`):

| Signal | Meaning |
|---|---|
| `spec-reviewed` | QA wrote spec findings |
| `spec-fixed` | dev handled every spec finding |
| `code-done` | dev implemented (committed locally, not pushed) |
| `code-reviewed` | QA wrote code findings |
| `code-fixed` | dev handled every code finding |
| `code-ready` (opt. PR#) | publish phase pushed the branch / opened the PR |

## Context-request side-channel

During server review, request file context only when the prompt says `review-checkout: base`, or during server spec review / legacy batch continuation when the prompt context is insufficient:

```
[bx:read-file:<path>:<start>-<end>]
```

Own line, repo-relative path, ≤200 lines, then wait — baxian injects the content. This does NOT consume the phase-signal watch, so you may request several before emitting your phase signal.

## Need-input side-channel

When you ask your human partner a question and pause for their answer (see the baxian-task-check skill), also emit, on its own line, with the current `token:` value:

```
[bx:need-input:<token>]
```

baxian shows a waiting badge in its UI so the user knows to open your terminal. This does NOT consume the phase-signal watch and does not advance the task — emit it each time you ask. The badge clears when the user types into your terminal or when your next phase signal fires.
