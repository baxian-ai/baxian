---
name: pr-recheck
description: QA re-evaluates a PR after dev responded to prior findings — verify closure, check new risks, verdict
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

No pane signal on success. **422 fallback** (same identity):
- request-changes: `gh pr review N --comment --body 'FINDINGS'`, then emit `pr-changes-requested` signal.
- approve: emit `pr-approved` signal.
