---
name: task-check
description: How to analyze a baxian-managed task before starting development
---

Before writing any code, read the `<task>` block in your prompt.

## Steps
1. Read `<task>` block — authoritative task source (no `.baxian/task.md` file).
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
