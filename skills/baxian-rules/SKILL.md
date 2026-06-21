---
name: baxian-rules
description: General rules and conventions for baxian-managed agents
disable-model-invocation: true
---

## General
- Cross-agent communication via GitHub PR records (description, commits, reviews, comments).
- PR description must start with `<!-- baxian:managed -->`.
- baxian dispatches via task and pane prompts.
- Stay in scope. Out-of-scope → create GitHub Issue.

## Authorization (QA)
Human authorization is input, not bypass. Judge risk independently.

## Phase Signals
Format: `[bx:KIND:TOKEN]`; pr-created variant: `[bx:pr-created:NUM:TOKEN]`.

Dispatch prompt provides template with `<token>` (and `<pr_number>` for pr-created) + real values. Substitute and emit on its own line. Not every phase needs a signal.
