---
name: baxian-pr-feedback
description: Dev processes PR review feedback (fix phase) and the pre-merge feedback pass (post-approve) — fetch, judge, act, signal back.
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields. `workdir:` is your fixed current directory with the task branch already checked out; do not change directories or branches. The PR is in `pr:`. Communicate via the GitHub PR; stay in scope (out-of-scope work goes to a new Issue). Route on `phase:`: follow §Fix for `fix`, §Post-Approve for `post-approve`.

## Fetch Feedback

Substitute `N` with your `pr:` field:

```bash
gh api --paginate repos/OWNER/REPO/pulls/N/reviews
gh api --paginate repos/OWNER/REPO/pulls/N/comments
gh api --paginate repos/OWNER/REPO/issues/N/comments
gh pr view N --json title,body,headRefName,headRefOid,baseRefName,reviewDecision,url
```

## Decide and Act

Judge each finding independently. No batch-dismissing.

For each actionable item:
1. In scope: fix. Reply `Fixed` (own line) + commit SHA.
2. Not appropriate: reply `Won't fix` (own line) + concrete reason.
3. Out of scope: create Issue, reply with link.
4. Already fixed: verify in code, reply `Fixed` + SHA.

Reply to every item, including duplicates (reference primary). Thread inline comments.

## Fix

QA requested changes on the PR in `pr:` (review round `round:`). Read all feedback (§Fetch Feedback), then handle every finding (§Decide and Act). If you change code, commit then push to your `branch:`: `git push origin HEAD:<branch>`. Emit your `signal:` (`pr-fixed`) with `token:` when done — even without a code push; baxian verifies work exists before routing to QA.

## Post-Approve

QA already approved. Before merge, re-process PR feedback idempotently — handle every item per §Fetch Feedback and §Decide and Act, plus:

- Idempotency: compute `T_self` = your latest reply timestamp per source. Respond to EVERY non-self comment with `created_at` > `T_self`, applied per review thread AND across the issue-comment stream.
- If you change code: commit + push (baxian routes to QA for recheck) and STOP — do NOT emit `pr-merge-ready` when you pushed code.
- If no code change is needed: re-fetch all sources before signaling. The server suppresses redispatches while you run, so new comments only reach you via this re-fetch. If unhandled items remain, process and re-fetch again. Emit your `signal:` (`pr-merge-ready`) with `token:` only when clean.
- Do not merge the PR yourself from this phase.

A `redispatch:` field means new feedback arrived while your previous pass ran — run this same §Post-Approve procedure again in full.

Signal wire format and emit rules: see the baxian-signals skill.
