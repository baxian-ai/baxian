---
name: baxian-task-check
description: How a dev analyzes and executes a baxian-managed develop/code task — read the structured prompt, plan, run the develop or code flow, signal back.
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields followed by the task `title:` and its description. Work in the directory named by `worktree:` — cd there before any file operation. Route on `phase:`: follow §Develop for `develop`, §Code for `code`.

If an `images:` list is present, read each path (baxian downloaded the user's uploads to the agent host) and factor them into the task.

## Analyze

1. Read `title:` and the description — the authoritative task source (no `.baxian/task.md` file).
2. Identify acceptance criteria, explicit vs implied requirements, edge cases, file/function references, linked docs/specs.
3. Plan the files to modify and the tests to write.

## Conventions

Your `exchange:` field selects the cross-agent medium:
- `github-pr` — communicate via the GitHub PR (description, commits, reviews, comments). Commit on the branch already checked out in your `worktree:` — do NOT create or push a differently-named branch, or baxian can't match the PR to your task. Stay in scope — out-of-scope work goes to a new GitHub Issue.
- `server-files` — baxian reads your worktree directly; do NOT push or open a PR (the publish phase does that). Stay in scope.

A PR you open MUST be ready for review (not Draft): do NOT use `--draft`; if it is draft after creation, run `gh pr ready` before signaling.

## Develop

Analyze the task's complexity before coding: a simple task goes Direct (just implement it); a complex one goes SDD (write a spec for QA review).

Two mutually-exclusive routes — pick ONE and emit only its signal:

- **Direct** — implement the change, then emit `signal:` with `token:`: for `exchange: github-pr`, after `gh pr create` (ready for review) emit `pr-created`; for `exchange: server-files`, after a local commit (do NOT push) emit `code-done`.
- **SDD** — available only when the dispatch carries a `spec-signal:` field (a QA partner exists); without it, Direct is your only route. Follow §Specification-Driven Development to get your design reviewed first, then emit `spec-signal:` (`spec-done`) with `token:`. Do NOT emit the default `signal:` on this route — that would skip spec review and push an unimplemented task forward. After QA approves the spec, baxian dispatches the code phase.

## Code

The spec is approved at `.baxian/spec.md`. Implement it, then emit your `signal:` with `token:`:
- `exchange: github-pr`: commit + push, `gh pr create` (ready for review), emit `pr-created`.
- `exchange: server-files`: local commit only (do NOT push, no PR), emit `code-done`.

## Specification-Driven Development (SDD)

Use it to have QA review your design before you write code.

- Write the spec to `.baxian/spec.md` in your worktree. Do NOT commit or push it — baxian reads the file directly for QA review.
- Then emit the `spec-signal:` (`spec-done`) with `token:`.

Signal wire format and emit rules: see the baxian-signals skill.
