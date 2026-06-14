---
name: server-spec-review
description: QA reviews an injected spec document in server mode — findings to findings.json, verdict via spec-reviewed signal
---

## Input

The spec document is INJECTED in your prompt. Never fetch branches, never use `gh`.

Truncated content or missing context: `[bx:read-file:<path>:<start>-<end>]` with real values (≤200 lines).

## Review

- Completeness: every requirement covered, interfaces and data flows defined, error paths specified.
- Correctness: internally consistent, no contradicting sections, feasible against the existing codebase.
- Ambiguity: any requirement readable two ways is a finding.
- Use `location` to point at the spec section (e.g. `"Section 3.2"` or a heading name).

## Output

Write findings to `.baxian/review/findings.json` in YOUR worktree (atomic: `.tmp` then `mv`):

```json
{"round":N,"verdict":"request-changes","findings":[{"id":"f-1","severity":"major","location":"Section 2","message":"..."}]}
```

Then emit the signal exactly once (token from your prompt):

```
[bx:spec-reviewed:<token>]
```
