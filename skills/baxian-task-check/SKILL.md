---
name: baxian-task-check
description: "Use when a baxian dispatch descriptor carries `phase: develop` or `phase: code` — the dev-side entry for analyzing and executing the task."
disable-model-invocation: true
---

baxian dispatches you with a block of `key: value` dispatch fields followed by the task `title:` and its description. `workdir:` is your fixed current directory and already has the task branch checked out; do not change directories or branches. Route on `phase:`: follow §Develop for `develop`, §Code for `code`. Signal wire format and emit rules: see the baxian-signals skill.

## Analyze

1. Read `title:` and the description — the authoritative task source. If an `images:` list is present, read each path (the user's uploaded images) and factor them in.
2. Identify acceptance criteria, explicit vs implied requirements, edge cases, file/function references, linked docs/specs.
3. Plan the files to modify and the tests to write.

## Your human partner

Installed skills and personal workflows apply as usual — baxian orchestrates task flow, not how you work. If your workflow calls for clarifying questions or a design approval, ask in your reply and wait: your human partner reads this session through baxian's web terminal and answers there. When you ask — and again when the answer arrives — emit the need-input side-channel signals exactly as the baxian-signals skill defines them (ask + answer-received, with the dispatch's `token:` value and your question ordinal), so baxian's waiting badge tracks the exchange. Asking is optional, never required.

## Conventions

Stay in scope — out-of-scope work goes to a new issue via your platform skill. Deliver only through this dispatch's signal route, never a skill's own finishing flow, and never merge — baxian owns merging.

Communicate through the platform PR (description, commits, reviews, comments). Load the `baxian-cli-<tool>` skill named by your `cli:` field (`cli: gh` means `baxian-cli-gh`) and take every platform command from it. Commit on the branch already checked out in `workdir:` — the PR must come from exactly the `branch:` value, or baxian can't match it to your task.

## Develop

How you develop is yours — your installed skills and workflows decide how you analyze, design, and implement. baxian defines only the exits, and you emit exactly one exit signal per dispatch:

- Deliver the implementation: follow §Deliver.
- Get a design reviewed before you code: follow §SDD.

## SDD

The companion for spec-first development: baxian routes your spec through review before you code.

The spec is a permanent repository document on the task branch.

1. Verify `git symbolic-ref --quiet --short HEAD` is byte-for-byte equal to the descriptor's original, case-sensitive `branch:` value. Derive the flat path with this single command: `branch="$(git symbolic-ref --quiet --short HEAD)" && slug="$(printf %s "$branch" | LC_ALL=C tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-48)" && hash16="$(printf %s "$branch" | openssl dgst -sha256 -r | cut -c1-16)" && spec_path="docs/specs/${slug}-${hash16}.md"`. Do not invent a fallback slug or a nested directory.
2. Start the file with YAML front matter whose `branch:` value is the JSON-quoted exact original branch, then write the design. Before any write, use one shell invocation rooted at the absolute logical `workdir:` to enforce all three guards: every existing component from Workdir through the target is a non-symlink and its canonical path stays under the canonical Workdir; the first target creation uses `set -o noclobber` so it is atomic and no-clobber; if the target already exists, compare its front-matter `branch:` value with the current branch byte-for-byte and continue only when they match. Re-check newly created directories and the target as non-symlinks before writing content. A collision, malformed front matter, canonical-prefix failure, or any ambiguous probe stops the task without overwriting the file.
3. Commit the spec and follow your `baxian-cli-<tool>` skill §Create. It pushes and adopts or creates the PR. After every common check passes, complete the `develop` / `§SDD` route from baxian-signals in its actor form, carrying the selected PR number.

Complete only the `§SDD` route: `§Deliver` selects direct code delivery instead.

After the spec is approved, baxian dispatches the code phase back to you.

## Code

Derive the approved repository spec path from `branch:` with §SDD's exact mapping and read it from the current branch; the descriptor also carries the already-bound `pr:` that §Create must adopt or reopen, never replace. Implement it, then follow §Deliver.

## Deliver

Commit, then create the PR per your `baxian-cli-<tool>` skill §Create — it owns push, non-interactive create with the source branch, repository, and target identity passed explicitly in that platform's own flags, Draft recovery, and the actor self-report segment. Complete the current phase's `§Deliver` route from baxian-signals in the actor-segment form that section specifies, only after its checks pass.
