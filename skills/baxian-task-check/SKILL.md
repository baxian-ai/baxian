---
name: baxian-task-check
description: Use when a baxian dispatch descriptor carries `phase: develop` or `phase: code` — the dev-side entry for analyzing and executing the task.
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields followed by the task `title:` and its description. `workdir:` is your fixed current directory and already has the task branch checked out; do not change directories or branches. Route on `phase:`: follow §Develop for `develop`, §Code for `code`. Signal wire format and emit rules: see the baxian-signals skill.

## Analyze

1. Read `title:` and the description — the authoritative task source. If an `images:` list is present, read each path (the user's uploaded images) and factor them in.
2. Identify acceptance criteria, explicit vs implied requirements, edge cases, file/function references, linked docs/specs.
3. Plan the files to modify and the tests to write.

## Your human partner

Installed skills and personal workflows apply as usual — baxian orchestrates task flow, not how you work. If your workflow calls for clarifying questions or a design approval, ask in your reply and wait: your human partner reads this session through baxian's web terminal and answers there. When you ask, also emit `[bx:need-input:<token>]` on its own line, substituting `<token>` with the dispatch's `token:` value (a literal `<token>` never matches), so baxian shows a waiting badge in its UI. Asking is optional, never required.

## Conventions

Stay in scope — out-of-scope work goes to a new GitHub Issue for `exchange: github-pr`, or into your commit message for `server-files`. Deliver only through this dispatch's signal route, never a skill's own finishing flow, and never merge — baxian owns merging.

Your `exchange:` field selects the cross-agent medium:

- `github-pr`: communicate via the GitHub PR (description, commits, reviews, comments). Commit on the branch already checked out in `workdir:` — do NOT create or push a differently-named branch, or baxian can't match the PR to your task.
- `server-files`: baxian reads your Workdir directly; do NOT push or open a PR (the publish phase does that).

## Develop

How you develop is yours — your installed skills and workflows decide how you analyze, design, and implement. baxian defines only the exits, and you emit exactly one exit signal per dispatch:

- Deliver the implementation: follow §Deliver (`signal:`).
- Get a design reviewed before you code: follow §SDD (`spec-signal:`) — available only when the dispatch carries a `spec-signal:` field; without it, delivering is your only exit.

## SDD

The companion for spec-first development: baxian routes your spec through review before you code.

1. Write the spec to `.baxian/spec.md` in your Workdir. Do NOT commit or push it — baxian reads the file directly for review.
2. Emit `spec-signal:` (`spec-done`) with `token:` — NOT the default `signal:`, which would skip spec review and push an unimplemented task forward.

After the spec is approved, baxian dispatches the code phase back to you.

## Code

The approved spec is at `.baxian/spec.md`. Implement it, then follow §Deliver.

## Deliver

Emit your `signal:` with `token:` when your `exchange:`'s completion step is done:

- `github-pr`: commit + push, `gh pr create` ready for review — do NOT use `--draft`; if the PR is draft after creation, run `gh pr ready` before signaling. Emit `pr-created`.
- `server-files`: local commit only (do NOT push, no PR). Emit `code-done`.
