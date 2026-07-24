---
name: baxian-server-feedback
description: The task owner responds to QA's server-review findings (response.json); Dev also publishes reviewed code in server-after-done.
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields. `workdir:` is your fixed current directory; do not change directories or branches. A Dev receives code feedback on its task branch. A Research agent receives only spec feedback on a detached default-branch checkout. Route on `phase:`: follow §Feedback for `server-feedback`, §Publish for `server-after-done`.

## Feedback

If an `images:` list is present, read each path (the user's uploaded images) and factor them in. QA's findings ride in the `findings:` block, or in the single `findings-file:` referenced by the current prompt when large — read only that Workdir-relative file, never infer the current set from older inbox files or conversation context. If the file cannot be read, do not guess at its contents: write `response.json` as `{"round":<round>,"token":"<token>","findingsDigest":"<findings-digest>","responses":[{"findingId":"findings-file-unreadable","action":"reject","rationale":"<path>: <what failed>"}]}` and emit your signal as usual — the server's coverage check escalates it for human attention; the `feedback:` field says what they target — `code` or `spec`. Judge each finding independently — QA can be wrong; fix only what is actually correct, otherwise reject. Handle EVERY finding by id.

If correction fields are present, rebuild the response against the current findings rather than replaying the rejected file. `correction-reason:` explains the rejection; include every `missing-finding-ids:` entry, omit every `unknown-finding-ids:` entry, and correct the response shape named by `schema-violation-codes:`. The current findings remain authoritative, so every current id still appears exactly once.

Do NOT push to any remote and do NOT open a PR in this phase — baxian reads your Workdir directly; publishing is deferred to the `server-after-done` phase.

For each finding:
- `fix` — for `feedback: code`, change the code, commit, and include the `commitSha` in your response item; for `feedback: spec`, revise `.baxian/spec.md` and any affected `.baxian/research/*.md` in place. Do NOT commit or push spec documents — baxian reads them directly.
- `reject` — concrete rationale why the finding is wrong or not applicable. Never reject just to save effort.
- `out-of-scope` — rationale plus where it is tracked (issue link or task note).

Write your response to `.baxian/review/response.json` in YOUR Workdir (`mkdir -p .baxian/review` first). Atomic write: write `response.json.tmp` first, then `mv response.json.tmp response.json`.

Schema — copy `round:`, `token:`, and `findings-digest:` exactly from the current prompt:

```json
{"round":<round>,"token":"<token>","findingsDigest":"<findings-digest>","responses":[{"findingId":"f-1","action":"fix"|"reject"|"out-of-scope","rationale":"..."}]}
```

Code-finding responses also carry `"commitSha":"..."` on every `fix`. Spec-finding responses omit `commitSha`. Before emitting the signal, compare the response IDs with the IDs in this prompt's findings: every current ID MUST appear exactly once, and no prior-round or invented ID may appear (ids may look like `b0-f-1` when the review was batched).

Then emit your `signal:` (`code-fixed` or `spec-fixed`) with `token:`.

## Publish

Publish the reviewed `branch:`:
- `publish: pr` — `git push -u origin <branch>`, then open a managed PR ready for review (not Draft). Split the authoritative `repo:` value at its first `/` into `<repo-host>` and `<repo-path>` (`<owner/repo>`); reject a malformed value. Prefix every `gh` command in this flow with `GH_HOST=<repo-host>` so inherited process state cannot select another instance. Strip a leading `Draft:`, `[Draft]`, `(Draft)`, or `WIP:` from `title:`. Stage the title and body in one shell invocation rooted at the descriptor Workdir: bind that Workdir as an absolute logical path; require `"$(cd -- "$workdir" 2>/dev/null && pwd -P)" = "$workdir"`; reject `.baxian` or `.baxian/tmp` when either exists as a symlink; create `.baxian/tmp`; re-check both ancestors as real directories and non-symlinks; generate unpredictable title/body names; require each target to be absent (`[ ! -e "$target" ] && [ ! -L "$target" ]`); write both files with quoted heredocs whose delimiters cannot occur as a line in their payloads; then require both targets to be regular files and non-symlinks. The body must end with `<!-- baxian:managed -->`. Never split the ancestor guards, creation, writes, and final checks across tool calls; if any step fails, stop without invoking `gh`. Create the PR non-interactively with `GH_HOST=<repo-host> gh pr create -R <repo:> --head <branch:> --base <base:> --title "$(cat <title-file>)" --body-file <body-file>`. Never put the title or body directly in the `gh` command. Never let `gh` infer repo, head, or base — inference reads the checkout's remotes and repository default, which can target the wrong fork or base. `repo:` is always present and authoritative; never substitute a local `git remote` lookup. If `base:` is absent, resolve it with `GH_HOST=<repo-host> gh api repos/<repo-path> --jq .default_branch`, then pass it explicitly. Before signalling, run `GH_HOST=<repo-host> gh pr view <pr_number> -R <repo:> --json isDraft --jq .isDraft`; if it returns `true`, run `GH_HOST=<repo-host> gh pr ready <pr_number> -R <repo:>`, then re-check once and require `false`. Do not emit `code-ready` if the ready operation or re-check fails or the PR remains a draft. Then emit `code-ready` carrying the new PR number: `[bx:code-ready:<pr_number>:<token>]`.
- `publish: branch` — `git push -u origin <branch>`, then emit `code-ready` with `token:`.

Signal wire format and emit rules: see the baxian-signals skill.
