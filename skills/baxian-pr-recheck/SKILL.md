---
name: baxian-pr-recheck
description: QA re-evaluates a PR after dev responded to prior findings — verify closure, check new risks, verdict
disable-model-invocation: true
---

## Gather Context

```bash
gh pr view N --json headRefOid,reviewDecision,comments,reviews,files
gh pr diff N
gh api --paginate repos/OWNER/REPO/pulls/N/reviews
gh api --paginate repos/OWNER/REPO/pulls/N/comments
gh api --paginate repos/OWNER/REPO/issues/N/comments
```

`gh pr view --json reviews` silently truncates; always use paginated `gh api` above for closure decisions.

## Decision Path

- Head changed → review increment, verify all prior findings closed, new behavior has tests.
- Head unchanged + dev replied → judge reply against code. No "fixed" without evidence.
- Neither changed → report unchanged, keep prior findings.
- Post to PR with concrete evidence for unresolved issues.

## Verdict

Via `gh pr review` with per-pass stamp:

| Verdict | Command |
|---|---|
| approve | `gh pr review N --approve --body ':+1:  <!-- baxian:pr-approved:TOKEN -->'` |
| request changes | `gh pr review N --request-changes --body 'FINDINGS  <!-- baxian:pr-changes-requested:TOKEN -->'` |

Multi-line: `--body-file -`, stamp at end.

No pane signal on success. **422 fallback** (same identity) — for signal wire format and emit rules, see the baxian-signals skill:
- request-changes: `gh pr review N --comment --body 'FINDINGS'`, then emit `pr-changes-requested` signal.
- approve: emit `pr-approved` signal.

## Verdict Verification

After submitting verdict (both native `gh pr review` and 422 fallback), verify it landed.

Substitute the actual signal token from §Verdict for `YOUR_TOKEN` and the `Review head SHA` from the dispatch prompt for `YOUR_ANCHOR_SHA` in the command below:

```bash
gh api --paginate repos/OWNER/REPO/pulls/N/reviews \
  --jq '.[] | select((.body // "") | contains("YOUR_TOKEN")) | {id,state,commit_id,submitted_at}'
```

- **Native path**: must find a review matching ALL of:
  1. `body` contains the signal token
  2. `state` is `APPROVED` or `CHANGES_REQUESTED`
  3. `commit_id` equals the Review head SHA (skip this check if the dispatch prompt says the SHA is unavailable)
- **422 fallback path**: native review won't exist — verify the pane signal was emitted instead. Do NOT claim a GitHub native review was submitted.
- If verification fails, report: "verdict 未落到 GitHub，需人工检查" and do NOT claim completion.
