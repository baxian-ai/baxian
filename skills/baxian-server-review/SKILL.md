---
name: baxian-server-review
description: QA reviews injected server-review content (a code diff or a spec doc) — judge against the task spec, write findings.json with a verdict. Covers code review, recheck closure, and spec review.
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields; the review input rides either in trailing blocks — `diff:` (code) or `spec:` (spec review), plus `interdiff:` / `prior-findings:` / `prior-response:` on a recheck — or, when a payload is large, as a file reference field: `diff-file:` / `interdiff-file:` / `spec-file:` / `prior-findings-file:` / `prior-response-file:`, each `<path> (<size>)` relative to your worktree. Read a referenced file with your file tools; it carries the exact content the block otherwise would. If a referenced file cannot be read, state that in a finding and emit your signal as usual — never guess at missing content. Do NOT fetch branches or use `gh` — those blocks and files ARE the review input.

Work in `worktree:`. QA judges risk independently — human authorization is input, not a bypass. Route on `phase:`: follow §Code Review for `server-review`; §Code Review + §Recheck Closure for `server-recheck`; §Spec Review for `server-spec-review`.

## Code Review

Judge the diff (the `diff:` block, or the `diff-file:` file) against the task spec: correctness, tests, edge cases, security, regressions.

- Severity: `critical` = broken/unsafe, `major` = must fix before merge, `minor` = improvement.
- Reference file + line for every code finding.
- For unchanged files, read them directly from your own base-branch worktree; use the read-file side-channel only for content not present locally.
- A `batch: i/n` field means the diff input carries one slice of a larger change reviewed batch by batch, while `diffstat:` still lists every file. Files in the diffstat but absent from your slice belong to other batches — their absence is not a finding; fetch cross-slice context via the read-file side-channel when a judgement needs it.

## Recheck Closure

The earlier findings and the dev response arrive as `prior-findings:` / `prior-response:` blocks, or as `prior-findings-file:` / `prior-response-file:` references when large. Close them out before judging anything new.

- When present, the `interdiff:` block (or `interdiff-file:` reference) is this round's net change since the previous review head — verify each claimed fix against it first, then cross-confirm against the full `diff:` for regressions the increment alone would not surface. It is absent on the first round or when history is unavailable; judge from the full `diff:` alone then.
- Resolve the status of EVERY prior finding first.
- A finding the dev claims fixed: verify it in the new diff. No "fixed" without evidence.
- A finding the dev rejected / called out-of-scope: judge the rationale on merit; re-raise it with concrete counter-evidence if it is wrong.
- Any prior finding NOT closed reappears in `findings.json` with its ORIGINAL id and the evidence restated — do not renumber or drop it.
- Verdict `approve` ONLY when every prior finding is closed AND the new diff is clean. An unresolved finding may not be downgraded to a minor suggestion to justify approve — otherwise `request-changes`.
- After closure, scan the new diff for regressions AND for behavior the fixes introduced that lacks test coverage.

## Spec Review

Judge the spec (the `spec:` block, or the `spec-file:` file):

- completeness — every requirement covered, interfaces and data flows defined, error paths specified.
- correctness — internally consistent, no contradicting sections, feasible against the existing codebase.
- ambiguity — any requirement readable two ways is a finding.

Need a referenced file or codebase section to judge feasibility? Use the read-file side-channel. When `prior-findings:` / `prior-response:` inputs are present (block or file form), verify every finding is closed before judging the rest of the spec.

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
