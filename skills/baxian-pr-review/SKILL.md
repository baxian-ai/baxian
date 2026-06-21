---
name: baxian-pr-review
description: QA performs a full independent pull request review — findings, verdict, approval
disable-model-invocation: true
---

Source of truth: PR, commits, comments, checks, issues.

## Gather Context

```bash
gh pr view N --json title,body,headRefName,headRefOid,baseRefName,reviewDecision,url,files
gh pr diff N
gh api --paginate repos/OWNER/REPO/pulls/N/reviews
gh api --paginate repos/OWNER/REPO/pulls/N/comments
gh api --paginate repos/OWNER/REPO/issues/N/comments
```

## Scope

Prioritize:
- Bugs, regressions, security, lifecycle, concurrency.
- Missing/weak/non-assertive tests.
- Coverage gaps for branches, errors, edge cases.
- PR vs issue vs repo rules mismatches.

## Findings

Inline comments on smallest relevant range. Concrete evidence + expected fix. Don't restate diff.

## Verdict

Via `gh pr review` with per-pass stamp:

| Verdict | Command |
|---|---|
| approve | `gh pr review N --approve --body ':+1:  <!-- baxian:pr-approved:TOKEN -->'` |
| request changes | `gh pr review N --request-changes --body 'FINDINGS  <!-- baxian:pr-changes-requested:TOKEN -->'` |

Multi-line: `--body-file -`, stamp at end.

No pane signal on success. **422 fallback** (same identity):
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
