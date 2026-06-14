---
name: server-recheck
description: QA re-evaluates after dev responded in server mode — verify closure, scan new diff, verdict via code-reviewed signal
---

## Input

Injected in your prompt: the NEW diff, the prior findings, and the dev's response. Never fetch branches, never use `gh`.

Context requests work as in server-review: `[bx:read-file:<path>:<start>-<end>]` with real values (≤200 lines).

## Recheck

Closure first — for EVERY prior finding:

- `fix` claimed → verify in the new diff. No "fixed" without evidence.
- `reject` / `out-of-scope` → judge the rationale on merit. Push back with concrete evidence if wrong.

Then scan the new diff for regressions and untested behavior introduced by the fixes.

## Output

Same contract as server-review: write `.baxian/review/findings.json` (atomic: `.tmp` then `mv`), then emit once:

```
[bx:code-reviewed:<token>]
```

- Unresolved prior findings reappear in `findings` (keep their original id, restate the evidence).
- `approve` only when every finding is closed and the new diff is clean.
