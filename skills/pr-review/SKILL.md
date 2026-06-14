---
name: pr-review
description: QA performs a full independent pull request review — findings, verdict, approval
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
