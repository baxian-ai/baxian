---
name: baxian-server-feedback
description: Dev responds to QA's server-review findings (response.json) and publishes the reviewed branch (server-after-done). Covers code findings, spec findings, and publish.
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields. `workdir:` is your fixed current directory with the task branch already checked out; do not change directories or branches. Route on `phase:`: follow §Feedback for `server-feedback`, §Publish for `server-after-done`.

## Feedback

QA's findings ride in the `findings:` block, or in a `findings-file:` referenced file when large — read it from the given Workdir-relative path; if the file cannot be read, do not guess at its contents: write `response.json` as `{"round":<round>,"responses":[{"findingId":"findings-file-unreadable","action":"reject","rationale":"<path>: <what failed>"}]}` and emit your signal as usual — the server's coverage check escalates it for human attention; the `feedback:` field says what they target — `code` or `spec`. Judge each finding independently — QA can be wrong; fix only what is actually correct, otherwise reject. Handle EVERY finding by id.

Do NOT push to any remote and do NOT open a PR in this phase — baxian reads your Workdir directly; publishing is deferred to the `server-after-done` phase.

For each finding:
- `fix` — for `feedback: code`, change the code (or spec), commit, include the `commitSha` in your response item; for `feedback: spec`, revise `.baxian/spec.md` in place. Do NOT commit or push it — baxian reads the file directly.
- `reject` — concrete rationale why the finding is wrong or not applicable. Never reject just to save effort.
- `out-of-scope` — rationale plus where it is tracked (issue link or task note).

Write your response to `.baxian/review/response.json` in YOUR Workdir (`mkdir -p .baxian/review` first). Atomic write: write `response.json.tmp` first, then `mv response.json.tmp response.json`.

Schema — substitute `<round>` with your `round:` field:

```json
{"round":<round>,"responses":[{"findingId":"f-1","action":"fix"|"reject"|"out-of-scope","rationale":"..."}]}
```

Code-finding responses also carry `"commitSha":"..."` on every `fix`. Spec-finding responses omit `commitSha`. Every finding id MUST have exactly one response item (ids may look like `b0-f-1` when the review was batched).

Then emit your `signal:` (`code-fixed` or `spec-fixed`) with `token:`.

## Publish

Publish the reviewed `branch:`:
- `publish: pr` — `git push -u origin <branch>`, open a managed PR (`gh pr create`; ready for review, not Draft). Emit `code-ready` carrying the new PR number: `[bx:code-ready:<pr_number>:<token>]`.
- `publish: branch` — `git push -u origin <branch>`, then emit `code-ready` with `token:`.

Signal wire format and emit rules: see the baxian-signals skill.
