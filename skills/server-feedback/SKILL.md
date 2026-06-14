---
name: server-feedback
description: Dev processes injected QA findings in server mode — respond per finding in response.json, signal code-fixed/spec-fixed
---

## Input

QA findings are INJECTED in your prompt (ids may look like `b0-f-1` when the review was batched). Judge each independently — QA can be wrong.

## Decide and Act

Every finding id gets EXACTLY ONE response item:

- `fix` — apply the change. Code phase: commit in the worktree and put the SHA in `commitSha`. Spec phase: revise the spec doc in place — never commit it, and omit `commitSha`.
- `reject` — concrete rationale why the finding is wrong or not applicable. Never reject to save effort.
- `out-of-scope` — rationale plus where it is tracked (issue link or follow-up note).

Do NOT push to any remote and do NOT open PRs in this phase — baxian reads your worktree directly.

## Output

Write `.baxian/review/response.json` in your worktree (`mkdir -p .baxian/review` first; atomic: `.tmp` then `mv`):

```json
{"round":N,"responses":[{"findingId":"f-1","action":"fix","rationale":"...","commitSha":"abc1234"}]}
```

(`commitSha` only in code phase.)

Then emit the signal exactly once (kind comes from your prompt — `code-fixed` in code phase, `spec-fixed` in spec phase; token from your prompt):

```
[bx:code-fixed:<token>]
```
