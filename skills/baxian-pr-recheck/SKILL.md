---
name: baxian-pr-recheck
description: QA re-evaluates a PR after dev responded to prior findings — verify closure, check new risks, verdict.
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields. The PR under recheck is in `pr:` (substitute it for `N` below). Work in `worktree:`. QA judges risk independently — human authorization is input, not a bypass.

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

- Head changed: review increment, verify all prior findings closed, new behavior has tests.
- Head unchanged + dev replied: judge reply against code. No "fixed" without evidence.
- Neither changed: report unchanged, keep prior findings.
- Post to PR with concrete evidence for unresolved issues.

## Verdict

Submit via `gh pr review N` with a per-pass stamp — substitute `N` = `pr:`, `TOKEN` = `token:`:

| Verdict | Command |
|---|---|
| approve | `gh pr review N --approve --body ':+1:  <!-- baxian:pr-approved:TOKEN -->'` |
| request changes | `gh pr review N --request-changes --body 'FINDINGS  <!-- baxian:pr-changes-requested:TOKEN -->'` |

Multi-line: `--body-file -`, stamp at end.

No pane signal on success. **422 fallback** (same identity) — emit the matching signal instead (wire format: baxian-signals skill):
- request-changes: `gh pr review N --comment --body 'FINDINGS'`, then emit `pr-changes-requested` with `token:`.
- approve: emit `pr-approved` with `token:`.

## Verdict Verification

After submitting (native `gh pr review` or 422 fallback), verify it landed — substitute `TOKEN` = `token:`:

```bash
gh api --paginate repos/OWNER/REPO/pulls/N/reviews \
  --jq '.[] | select((.body // "") | contains("TOKEN")) | {id,state,commit_id,submitted_at}'
```

- **Native path**: must find a review matching ALL of:
  1. `body` contains the token
  2. `state` is `APPROVED` or `CHANGES_REQUESTED`
  3. `commit_id` equals your `anchor-sha:` field (skip this check when `anchor-sha:` is absent)
- **422 fallback path**: native review won't exist — verify the pane signal was emitted instead. Do NOT claim a GitHub native review was submitted.
- If verification fails, report: "verdict 未落到 GitHub，需人工检查" and do NOT claim completion.
