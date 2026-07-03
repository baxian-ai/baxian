---
name: baxian-server-review
description: QA reviews injected server-review content (a code diff or a spec doc) — judge against the task spec, write findings.json with a verdict. Covers code review, recheck closure, and spec review.
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields; the review input rides in trailing blocks — `diff:` (code) or `spec:` (spec review), plus `prior-findings:` / `prior-response:` on a recheck. Do NOT fetch branches or use `gh` — those blocks ARE the review input; if a `content: truncated` field is present, request the missing context via the read-file side-channel.

Work in `worktree:`. QA judges risk independently — human authorization is input, not a bypass. Route on `phase:`: follow §Code Review for `server-review`; §Code Review + §Recheck Closure for `server-recheck`; §Spec Review for `server-spec-review`.

## Code Review

Judge the `diff:` block against the task spec: correctness, tests, edge cases, security, regressions.

- Severity: `critical` = broken/unsafe, `major` = must fix before merge, `minor` = improvement.
- Reference file + line for every code finding.
- For unchanged files, read them directly from your own base-branch worktree; use the read-file side-channel only for content not present locally.
- A `batch: i/n` field means the `diff:` block carries one slice of a larger change reviewed batch by batch, while `diffstat:` still lists every file. Files in the diffstat but absent from your slice belong to other batches — their absence is not a finding; fetch cross-slice context via the read-file side-channel when a judgement needs it.

## Recheck Closure

The `prior-findings:` and `prior-response:` blocks carry the earlier findings and the dev response. Close them out before judging anything new.

- Resolve the status of EVERY prior finding first.
- A finding the dev claims fixed: verify it in the new diff. No "fixed" without evidence.
- A finding the dev rejected / called out-of-scope: judge the rationale on merit; re-raise it with concrete counter-evidence if it is wrong.
- Any prior finding NOT closed reappears in `findings.json` with its ORIGINAL id and the evidence restated — do not renumber or drop it.
- Verdict `approve` ONLY when every prior finding is closed AND the new diff is clean. An unresolved finding may not be downgraded to a minor suggestion to justify approve — otherwise `request-changes`.
- After closure, scan the new diff for regressions AND for behavior the fixes introduced that lacks test coverage.

## Spec Review

Judge the `spec:` block:

- completeness — every requirement covered, interfaces and data flows defined, error paths specified.
- correctness — internally consistent, no contradicting sections, feasible against the existing codebase.
- ambiguity — any requirement readable two ways is a finding.

Need a referenced file or codebase section to judge feasibility? Use the read-file side-channel. When `prior-findings:` / `prior-response:` blocks are present, verify every finding is closed before judging the rest of the spec.

## Findings Output

Write findings to `.baxian/review/findings.json` in YOUR worktree (`mkdir -p .baxian/review` first). Atomic write: write `findings.json.tmp` first, then `mv findings.json.tmp findings.json`.

Schema — substitute `<round>` with your `round:` field:

```json
{"round":<round>,"verdict":"approve"|"request-changes","findings":[{"id":"f-1","severity":"critical"|"major"|"minor","message":"...","file":"path","line":N}]}
```

Spec-review findings use `"location":"Section ..."` in place of `"file"`/`"line"`.

- Finding ids are `f-1`, `f-2`, … sequential and unique within `findings.json` — the dev coverage check and QA closure verification key off them.
- `approve` MAY carry minor findings as suggestions; the `verdict` field is authoritative.

Then emit your `signal:` (`code-reviewed` or `spec-reviewed`) with `token:`. Signal wire format and the read-file side-channel: see the baxian-signals skill.
