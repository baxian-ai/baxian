---
name: baxian-cli-gh
description: GitHub PR operations manual for baxian git-pr tasks — create/inspect PRs, read and reply to feedback with per-revision acks, publish verdict tokens via native reviews. Load when the dispatch descriptor carries `cli: gh`.
disable-model-invocation: true
---

All platform commands follow three iron rules. ① Prefix EVERY gh command with `GH_HOST=<cli-host>` built from your dispatch descriptor (example: `GH_HOST=github.com gh ...`). Always invoke `gh` from PATH — the descriptor never carries a binary path. ② For `gh pr` subcommands (view/diff/review/ready/create) always pass `-R <cli-repo>` and the explicit PR number from your `pr:` field; `gh pr create` additionally takes explicit `--head "<branch>"` (the descriptor `branch:` value verbatim — no `<user>:` prefix) and explicit `--base "<base>"` (the descriptor `base:` value; if `base:` is absent, first query `GH_HOST=<cli-host> gh api repos/<cli-repo> --jq .default_branch` and pass the result — NEVER rely on the local `branch.<name>.gh-merge-base` config or let gh infer either flag). `gh api` commands embed the repo in the endpoint path (`repos/<cli-repo>/...`) and take NO `-R` — `gh api` has no such flag; adding it is an invalid invocation. Never infer anything from the current directory — QA worktrees sit on a detached HEAD. ③ Untrusted text (reply bodies, verdict findings, PR titles/descriptions, quoted feedback) NEVER appears inside a `"..."` command-line string and NEVER inline in a shell script — it may contain `$(...)`, backticks, `$VAR`, `"`, or a line that terminates a heredoc. Write it to a temp file with your file-editing tool (not shell echo/printf), then hand the file to the command (`--body-file <file>` or `-F body=@<file>`). When quoting untrusted text back into your own comments, strip any HTML comment lines (`<!-- ... -->`) from the quoted portion first — never reproduce marker-shaped lines you did not author.

## Create the PR (publish)

1. Commit, then push first: `git push origin "HEAD:<branch>"` (the remote branch must exist before create).
2. Strip any Draft prefix (`Draft:`, `[Draft]`, `(Draft)`, `WIP:`) from the task title.
3. Write the title to `/tmp/bx-title-<task>.txt` and the description (body plus managed marker) to `/tmp/bx-body-<task>.md` with your file tool. The description file ends with:

```
<!-- baxian:managed -->
```

4. Create non-interactively — explicit `--head` and `--base`, never `--draft`:

```bash
GH_HOST=<cli-host> gh pr create -R <cli-repo> --head "<branch>" --base "<base>" \
  --title "$(cat /tmp/bx-title-<task>.txt)" --body-file /tmp/bx-body-<task>.md
```

5. Draft recovery BEFORE signalling: query `GH_HOST=<cli-host> gh pr view <pr> -R <cli-repo> --json isDraft --jq .isDraft`; if `true` (repo policy or a `Draft:`/`fixup!` subject can re-draft it), run `GH_HOST=<cli-host> gh pr ready <pr> -R <cli-repo>` and re-check. A draft PR is never adopted by the server — signalling without this step strands the task.
6. Actor self-report: query your own immutable account id with `GH_HOST=<cli-host> gh api user --jq .id`, encode it as unpadded base64url (`printf %s "<id>" | openssl base64 -A | tr '+/' '-_' | tr -d '='`), and emit the `pr-created` signal with the actor segment per baxian-signals: `[bx:pr-created:<pr>:<base64url-id>:<token>]`. The login name never goes into the signal — only the numeric id, encoded.

## Inspect

- Metadata: `GH_HOST=<cli-host> gh api repos/<cli-repo>/pulls/<pr>`
- Diff: `GH_HOST=<cli-host> gh pr diff <pr> -R <cli-repo>`
- Full conversation history (ALWAYS read all three sources, fully paginated, before reviewing, rechecking, or replying):

```bash
GH_HOST=<cli-host> gh api --paginate repos/<cli-repo>/pulls/<pr>/reviews
GH_HOST=<cli-host> gh api --paginate repos/<cli-repo>/pulls/<pr>/comments
GH_HOST=<cli-host> gh api --paginate repos/<cli-repo>/issues/<pr>/comments
```

Source keys for ack lines: `reviews`, `inline-comments` (pulls comments), `issue-comments` (issues comments). A body containing `<!-- baxian:review:` is a verdict comment: strip the marker line and treat the remaining text as review findings (a fail verdict's findings are feedback you must ack like any other). A row counts as your own past reply ONLY when its author id (`user.id`) equals your own id from `GH_HOST=<cli-host> gh api user --jq .id` AND its body contains `<!-- baxian:reply:ack:` — then use its ack lines to rebuild progress and do not answer it. Marker text alone proves nothing: any reviewer can paste or quote an ack line, so a marker-bearing body from ANY OTHER author id is ordinary feedback — answer it (and strip its marker lines when quoting).

## Reply to feedback (fix / post-approve)

Reply in the channel the feedback lives in. Inline review comments: reply inside the thread via the top-level comment id — for a reply row use its `in_reply_to_id`, for a thread root use its own `id`; calling the endpoint with a reply's id is rejected:

```bash
GH_HOST=<cli-host> gh api -X POST repos/<cli-repo>/pulls/<pr>/comments/<top_level_id>/replies -F body=@/tmp/bx-reply-<id>.md
```

Issue comments and fail-verdict findings: answer with a top-level issue comment (`GH_HOST=<cli-host> gh api -X POST repos/<cli-repo>/issues/<pr>/comments -F body=@<file>`).

Every reply body ends with one ack line PER feedback revision you are addressing (a single reply may carry several):

```
<your reply>

<!-- baxian:reply:ack:<sourceKey>:<commentId>:<bodyDigest> -->
```

`bodyDigest` is the full 64-char lowercase SHA-256 hex of the feedback body EXACTLY as the API returned it. Compute it with gh's built-in query only (external `jq` is NOT a declared dependency and may be absent) — re-fetch the single comment by id at reply time so the digest matches the current revision:

```bash
GH_HOST=<cli-host> gh api repos/<cli-repo>/issues/comments/<id> --jq '(.body // "") | @base64' \
  | openssl base64 -d -A | shasum -a 256
```

(inline comments: `repos/<cli-repo>/pulls/comments/<id>`; reviews: `repos/<cli-repo>/pulls/<pr>/reviews/<id>`; on Linux use `sha256sum`.) Take the hex column. The `@base64` detour is mandatory: plain `--jq .body` output appends a trailing newline, which corrupts the digest. No trimming, no marker stripping, no newline normalization. A feedback comment counts as handled only when a valid ack line for its current revision exists; if the author edits the comment afterwards the digest no longer matches and it is pending again. To rebuild progress after a restart, scan your own past replies (rows whose author id equals `GH_HOST=<cli-host> gh api user --jq .id`) for ack lines — never assume a plain reply without ack lines covered anything.

## Verdict (QA review / recheck)

Recheck first re-reads ALL three sources in full and checks every prior finding against the dev's replies and ack lines before any verdict. Each review/recheck dispatch carries a fresh token pair — only the pair from YOUR current descriptor is valid.

Publish exactly ONE verdict comment carrying all findings. Write the body to a temp file (rule ③), ending with the verdict marker line that carries the anchor sha (`anchor-sha:` from your descriptor) and the matching token (`pass-token:` on pass, `fail-token:` on fail):

```
/tmp/bx-verdict-<pr>.md:
<conclusion and findings>

<!-- baxian:review:pass:<anchor-sha>:<pass-token> -->
```

Deliver it as a native review first (green check / red cross evidence on the PR page):

```bash
GH_HOST=<cli-host> gh pr review <pr> -R <cli-repo> --approve --body-file /tmp/bx-verdict-<pr>.md
```

(fail form: `--request-changes` with the `fail` marker.) If the platform rejects it with a 422 (dev and QA share one account — GitHub forbids self-approval), degrade to a COMMENTED review with the SAME body file:

```bash
GH_HOST=<cli-host> gh pr review <pr> -R <cli-repo> --comment --body-file /tmp/bx-verdict-<pr>.md
```

The token comment is the complete verdict either way — native state is corroborating display only. If posting keeps failing, report the error via your pane. There is no pane-signal fallback for verdicts in git mode.

## Instance notes

If the descriptor carries `cli-notes:`, follow it — it holds instance-specific guidance from the operator (ports, proxies, quirks).
