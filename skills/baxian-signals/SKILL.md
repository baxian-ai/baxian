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

## How to emit

The dispatch prompt hands you a template with placeholders plus the literal values on companion lines:

```
[bx:pr-fixed:<token>]
token: a1b2c3d4e5f6
```

1. Substitute `<token>` with the value on the `token:` line. `<pr_number>` (only `pr-created`, and `code-ready` when publishing as a PR) is the number of the PR you just created/opened with `gh pr create` — the dispatch prompt carries no PR-number line.
2. Emit the filled signal **alone on its own line**.
3. **Never echo the `<…>` placeholder verbatim** — the scanner's strict regex cannot match angle-bracket placeholders, so a verbatim template echo fires nothing and the task hangs forever waiting on a signal.
4. Emit the kind the prompt asks for, **exactly once**, only when its precondition holds. baxian consumes the first matching signal whose token matches the active dispatch; the token rotates every dispatch, so a stale or guessed token never fires.

## Signal catalog

Phase signals — the per-dispatch transition signals baxian consumes to advance a task. The dispatch prompt always names which one to emit and when.

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

During server review you may request file context baxian did not inject:

```
[bx:read-file:<path>:<start>-<end>]
```

Own line, repo-relative path, ≤200 lines, then wait — baxian injects the content. This does NOT consume the phase-signal watch, so you may request several before emitting your phase signal.
