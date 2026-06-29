---
name: baxian-server-feedback
description: Dev responds to QA's server-review findings (response.json) and publishes the reviewed branch (server-after-done). Covers code findings, spec findings, and publish.
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields. Work in `worktree:`. Route on `phase:`: `server-feedback` → §Feedback, `server-after-done` → §Publish.

## Feedback

QA's findings ride in the `findings:` block. Judge each finding independently — QA can be wrong; fix only what is actually correct, otherwise reject. Handle EVERY finding by id. The `feedback:` field is `code` or `spec`.

Do NOT push to any remote and do NOT open a PR in this phase — baxian reads your worktree directly; publishing is deferred to the `server-after-done` phase.

For each finding:
- `fix` — `feedback: code` → change the code (or spec), commit, include the `commitSha` in your response item. `feedback: spec` → revise `.baxian/spec.md` in place. Do NOT commit or push it — baxian reads the file directly.
- `reject` — concrete rationale why the finding is wrong or not applicable. Never reject just to save effort.
- `out-of-scope` — rationale plus where it is tracked (issue link or task note).

Write your response to `.baxian/review/response.json` in YOUR worktree (`mkdir -p .baxian/review` first). Atomic write: write `response.json.tmp` first, then `mv response.json.tmp response.json`.

Schema — substitute `<round>` with your `round:` field:

```json
{"round":<round>,"responses":[{"findingId":"f-1","action":"fix"|"reject"|"out-of-scope","rationale":"..."}]}
```

Code-finding responses also carry `"commitSha":"..."` on every `fix`. Spec-finding responses omit `commitSha`. Every finding id MUST have exactly one response item (ids may look like `b0-f-1` when the review was batched).

Then emit your `signal:` (`code-fixed` or `spec-fixed`) with `token:`.

## Publish

Publish the reviewed `branch:`:
- `publish: pr` — `git push -u origin <branch>`, open a managed PR (`gh pr create`; the body MUST end with the `<!-- baxian:managed -->` marker or baxian ignores the PR's merge/comment events; ready for review, not Draft). Emit `code-ready` carrying the new PR number: `[bx:code-ready:<pr_number>:<token>]`.
- `publish: branch` — `git push -u origin <branch>`, then emit `code-ready` with `token:`.

Signal wire format and emit rules: see the **baxian-signals** skill.
