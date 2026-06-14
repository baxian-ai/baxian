---
name: server-review
description: QA reviews an injected diff in server mode — findings to findings.json, verdict via code-reviewed signal
---

## Input

The diff is INJECTED in your prompt. Never fetch branches, never use `gh` — the injected diff plus your base-branch worktree is the complete review input.

Need context beyond the diff? Emit on its own line and wait for injection (substitute real values — the placeholder form below never fires):

```
[bx:read-file:<path>:<start>-<end>]
```

Relative path only, ≤200 lines per request. Your own worktree (base branch) is readable directly for unchanged files.

## Review

- Judge against the task spec: correctness, tests, edge cases, security, regressions.
- Severity: `critical` = broken/unsafe, `major` = must fix before merge, `minor` = improvement.
- Reference `file` + `line` from the diff for every code finding.

## Output

Write findings to `.baxian/review/findings.json` in YOUR worktree. Atomic write — temp file then rename:

```bash
mkdir -p .baxian/review
cat > .baxian/review/findings.json.tmp << 'EOF'
{"round":N,"verdict":"request-changes","findings":[{"id":"f-1","severity":"major","message":"...","file":"src/x.ts","line":42}]}
EOF
mv .baxian/review/findings.json.tmp .baxian/review/findings.json
```

- `verdict` is authoritative: `approve` or `request-changes`. Approve MAY carry minor findings as suggestions.
- Finding ids: `f-1`, `f-2`, … unique within the file.

Then emit the signal exactly once (token comes from your prompt):

```
[bx:code-reviewed:<token>]
```
