---
name: baxian-task-check
description: How a dev analyzes and executes a baxian-managed develop/code task — read the structured prompt, plan, run the develop or code flow, signal back.
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields followed by the task `title:` and its description. Work in the directory named by `worktree:` — cd there before any file operation. Route on `phase:`: follow §Develop for `develop`, §Code for `code`.

If an `images:` list is present, read each path (baxian downloaded the user's uploads to the agent host) and factor them into the task.

## Analyze

1. Read `title:` and the description — the authoritative task source.
2. Identify acceptance criteria, explicit vs implied requirements, edge cases, file/function references, linked docs/specs.
3. Plan the files to modify and the tests to write.

## Conventions

Stay in scope — out-of-scope work goes to a new GitHub Issue. Your `exchange:` field selects the cross-agent medium:

- `github-pr`: communicate via the GitHub PR (description, commits, reviews, comments). Commit on the branch already checked out in your `worktree:` — do NOT create or push a differently-named branch, or baxian can't match the PR to your task.
- `server-files`: baxian reads your worktree directly; do NOT push or open a PR (the publish phase does that).

## Develop

Gauge the task's complexity, then pick ONE of two mutually-exclusive routes and emit only its signal:

- **Direct** (simple task): implement it, then follow §Deliver.
- **SDD** (complex task): follow §Specification-Driven Development to get your design reviewed before you code. Available only when the dispatch carries a `spec-signal:` field (a QA partner exists); without it, Direct is your only route.

## Code

The approved spec is at `.baxian/spec.md`. Implement it, then follow §Deliver.

## Deliver

Emit your `signal:` with `token:` once the completion for your `exchange:` is done:

- `github-pr`: commit + push, `gh pr create` ready for review — do NOT use `--draft`; if the PR is draft after creation, run `gh pr ready` before signaling. Emit `pr-created`.
- `server-files`: local commit only (do NOT push, no PR). Emit `code-done`.

## Specification-Driven Development (SDD)

1. Write the spec to `.baxian/spec.md` in your worktree. Do NOT commit or push it — baxian reads the file directly for QA review.
2. Emit `spec-signal:` (`spec-done`) with `token:` — NOT the default `signal:`, which would skip spec review and push an unimplemented task forward.

After QA approves the spec, baxian dispatches the code phase back to you.

Signal wire format and emit rules: see the baxian-signals skill.
