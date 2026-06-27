---
name: baxian-pr-feedback
description: Process review feedback on a PR — Fixed/Won't fix each finding, create issues for out-of-scope items
disable-model-invocation: true
---

## Fetch Feedback

```bash
gh api --paginate repos/OWNER/REPO/pulls/N/reviews
gh api --paginate repos/OWNER/REPO/pulls/N/comments
gh api --paginate repos/OWNER/REPO/issues/N/comments
gh pr view N --json title,body,headRefName,headRefOid,baseRefName,reviewDecision,url
```

## Decide and Act

Judge each finding independently. No batch-dismissing.

For each actionable item:
1. In scope → fix. Reply `Fixed` (own line) + commit SHA.
2. Not appropriate → reply `Won't fix` (own line) + concrete reason.
3. Out of scope → create Issue, reply with link.
4. Already fixed → verify in code, reply `Fixed` + SHA.

Reply to every item, including duplicates (reference primary). Thread inline comments.

## Fix Completion

Emit `pr-fixed` when done — even without code push. baxian verifies work exists before routing to QA. Signal wire format and emit rules: see the baxian-signals skill.
