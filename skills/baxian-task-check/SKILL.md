---
name: baxian-task-check
description: How to analyze a baxian-managed task before starting development
disable-model-invocation: true
---

Before writing any code, read the task in your prompt — the `Phase:` / `Role:` header followed by the `Title:` line and its description.

## Steps
1. Read the prompt's `Title:` line and description — the authoritative task source (no `.baxian/task.md` file).
2. Identify acceptance criteria.
3. Plan: files to modify, tests to write.

## What to look for
- Explicit vs implied requirements
- Edge cases
- File/function references
- Linked docs, screenshots, specs

## When to ask vs. proceed
- Clear → start.
- Missing info + PR exists → record in PR description.
- Missing info + no PR → pick reasonable interpretation, write assumption after `<!-- baxian:managed -->` marker (marker MUST be line 1), or create task if blocked.
- Minor ambiguity → proceed, note in PR.
- Always record assumptions (PR, task, or commit message).

## Specification-Driven Development (SDD)

Optional, and offered only when the dispatch prompt gives you a `spec-done` signal (a QA partner exists). Use it to have QA review your design before you write code.

- Write the spec to `.baxian/spec.md` in your worktree. Do NOT commit or push it — baxian reads the file directly for QA review.
- Then emit the `spec-done` signal the prompt gives you (with its token).
- Skip it and implement directly when the change is small or the design is unambiguous.

After QA approves the spec, baxian dispatches the code phase to implement it.
