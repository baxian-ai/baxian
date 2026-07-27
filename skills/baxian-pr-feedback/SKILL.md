---
name: baxian-pr-feedback
description: Dev processes PR review feedback (fix phase) and the pre-merge feedback pass (post-approve) — fetch, judge, act, signal back.
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields. `workdir:` is your fixed current directory with the task branch already checked out; do not change directories or branches. The PR is in `pr:`. If an `images:` list is present, read each path (the user's uploaded images) and factor them in. Communicate via the platform PR; stay in scope (out-of-scope work goes to a new issue). Route on `phase:`: follow §Fix for `fix`, §Post-Approve for `post-approve`.

Load the `baxian-cli-<tool>` skill named by your `cli:` field and take every platform command from it: its §Inspect for reading feedback, its §Reply for the reply mechanics, its issue command for the out-of-scope step in §Decide and Act. Feedback that arrives as a review body (not an inline thread) is answered with a top-level comment carrying that review's ack line — a review can never ack another review, so replying in kind leaves it pending and blocks merge-ready. Progress is tracked by per-revision ack marker lines (one per feedback revision you addressed, digest-bound so an edited comment becomes pending again), never by reply timestamps.

## Fetch Feedback

Read every comment source of the PR in `pr:`, fully paginated, with the commands from your `baxian-cli-<tool>` skill §Inspect. A source you did not read is a finding you will miss.

## Decide and Act

Judge each finding independently. No batch-dismissing.

For each actionable item:
1. In scope: fix. Reply `Fixed` (own line) + commit SHA.
2. Not appropriate: reply `Won't fix` (own line) + concrete reason.
3. Out of scope: create an issue through your platform skill, reply with link.
4. Already fixed: verify in code, reply `Fixed` + SHA.

Reply to every item, including duplicates (reference primary). Thread inline comments.

## Fix

QA requested changes on the PR in `pr:`. Read all feedback (§Fetch Feedback), then handle every finding (§Decide and Act). If you change code, commit then push to your `branch:`: `git push origin HEAD:<branch>`. Complete the `fix` / `§Fix` route from baxian-signals with `token:` when done — even without a code push; baxian verifies work exists before routing to QA.

When the descriptor carries `stage: spec`, the object under review is the repository spec derived by baxian-task-check §SDD, not the implementation. Apply accepted findings to that spec. Any file change must be committed and pushed to `branch:` before completing the route; when every finding is resolved only by replies and no file changed, complete the route after the replies. When `stage:` is absent, follow the code-fix path above.

## Post-Approve

QA already approved. Before merge, re-process PR feedback idempotently — handle every item per §Fetch Feedback and §Decide and Act, plus:

- If you change code: commit + push (baxian routes to QA for recheck) and STOP — do NOT complete the route when you pushed code.
- If no code change is needed: re-fetch all sources before signaling. The server suppresses redispatches while you run, so new comments only reach you via this re-fetch. If unhandled items remain, process and re-fetch again. Complete the `post-approve` / `§Post-Approve` route from baxian-signals with `token:` only when clean.
- Do not merge the PR yourself from this phase.

Signal wire format and emit rules: see the baxian-signals skill.
