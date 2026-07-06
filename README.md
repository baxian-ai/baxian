<div align="center">

<img src="https://raw.githubusercontent.com/baxian-ai/baxian/main/assets/logo/baxian.png" alt="baxian logo" width="96">

# baxian

**Your AI agent team — Dev agents build, QA agents review, every change ships reviewed.**

**English** · [简体中文](https://github.com/baxian-ai/baxian/blob/main/README.zh-CN.md)

[Quick start](#quick-start) · [Features](#features) · [The workflow](#the-workflow) · [How it works](#how-it-works) · [Configuration](#configuration)

[![npm](https://img.shields.io/npm/v/baxian)](https://www.npmjs.com/package/baxian)
[![CI](https://github.com/baxian-ai/baxian/actions/workflows/test.yml/badge.svg)](https://github.com/baxian-ai/baxian/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/baxian-ai/baxian/blob/main/LICENSE)

<img src="https://raw.githubusercontent.com/baxian-ai/baxian/main/assets/screenshots/dashboard.webp" alt="baxian dashboard — a live terminal wall of Dev and QA agents" width="920">

</div>

## Why baxian

baxian pairs every **Dev agent** with an independent **QA agent**: the Dev implements and opens a pull request, the QA reviews it with fresh eyes, and the loop of findings and fixes runs automatically until the change is approved.

baxian is **tmux-native**. An agent is just an interactive Claude Code or Codex session inside a tmux session — the terminal you see in the browser is the real pane, the same one you can `tmux attach` to from a shell. Close the browser and the fleet keeps working.

## Features

- **Terminal wall** — the dashboard embeds every agent's live terminal (streamed over WebSocket, rendered with xterm.js). Click a pane to type into the real session; no context switching to find out what an agent is doing.
- **Automated review loop** — QA findings are structured (`critical` / `major` / `minor`, file and line), Dev responses are per-finding (`fix` / `reject` with rationale and commit), and rounds repeat until the verdict is `approve`.
- **Reviews happen on real GitHub pull requests** — branch-per-task, automatic PR creation, review polling through the `gh` CLI; with `merge: "auto"`, baxian merges the PR itself once you confirm the approved task.
- **Built-in server review mode (fallback)** — set `review.mode: "server"` to run the review loop through the server's own protocol when a PR is not an option.
- **Human spec gate (optional)** — with `specApproval: "human"` on a project, a task that starts with a spec parks at `spec-ready` once QA approves the spec, and coding waits for your sign-off.
- **Local & remote agents** — run agents on any machine reachable over SSH; baxian manages the remote tmux sessions for you.
- **No API keys** — agents run the interactive Claude Code / Codex CLIs, so your existing subscriptions are the only credentials involved.
- **Quality of life** — bilingual UI (English / 简体中文), browser notifications when tasks finish, image upload straight into an agent's terminal, and optional pixel-art agent pets.

## The workflow

1. **Create a task** in the web console (or from the command line with `baxian task create`).
2. A **Dev agent** takes it: branch, implementation, tests, pull request.
3. A **QA agent** reviews the diff independently and submits findings.
4. The Dev agent answers every finding — fixing or rejecting with a rationale — and pushes.
5. Repeat until **approve**. You confirm the result, and the PR gets merged — by baxian itself if the project sets `merge: "auto"`, otherwise by hand.

<p align="center">
<img src="https://raw.githubusercontent.com/baxian-ai/baxian/main/assets/screenshots/task-detail.webp" alt="Task detail — status, PR, and the full review record" width="820">
</p>

Every round is recorded and browsable — the QA review with its findings, and the Dev responses with their commits.

## How it works

```
   Browser (React + xterm.js)
        │  REST + WebSocket
        ▼
   baxian server (Node + Fastify)
   task state · review rounds · GitHub poller
        │  tmux send-keys / capture-pane
        ├────────────────┐
        ▼                ▼ SSH
   local tmux        remote tmux (any host)
   dev-1 · qa-1      dev-2 · qa-2
```

The server owns all state (tasks, review rounds, agent bindings) and drives agents by injecting prompts into their tmux panes and watching the output. Agents never talk to each other directly — the server relays review requests and feedback between the Dev and QA sides.

## Requirements

> - **Node.js ≥ 22.13**
> - **tmux** on every machine that runs agents (local and remote)
> - **Claude Code** (`claude`) and/or **Codex** (`codex`) CLI installed and logged in
> - **git**, and the **GitHub CLI** (`gh`, authenticated) if you use the GitHub integration

## Quick start

```sh
npm install -g baxian
baxian
```

Open <http://localhost:3000>. The first run creates `~/.baxian/config.json` for you.

Then, in the console:

1. **New project** — point it at a git repository.
2. **Add agents** — a Dev/QA pair (for example Claude Code as Dev, Codex as QA), each with a working directory containing a clone of the repo.
3. **New task** — describe what you want; the Dev agent picks it up and the review loop takes over.

### CLI

```sh
baxian                    # start the server (default command)
baxian status             # status of all agents
baxian attach <agent-id>  # attach to an agent's tmux session, local or remote
baxian stop <agent-id>    # interrupt an agent
baxian task create -p <project> -t "title" -a <dev-id> [-d "description"]
baxian task list -p <project>
```

## Configuration

baxian reads `./baxian.json` from the working directory first, then falls back to `~/.baxian/config.json` (`baxian start -c <path>` overrides both). A minimal configuration:

```json
{
  "review": { "rounds": 10 },
  "server": { "port": 3000, "host": "127.0.0.1" },
  "host": [
    { "id": "worker-01", "hostname": "worker-01.internal", "user": "agent" }
  ],
  "project": [
    {
      "id": "my-project",
      "repo": "https://github.com/your-org/your-repo.git",
      "merge": null,
      "agent": [
        [
          { "id": "dev-1", "runtime": "claude-code", "role": "dev", "mode": "local", "workdir": "/path/to/repo" },
          { "id": "qa-1",  "runtime": "codex",       "role": "qa",  "mode": "local", "workdir": "/path/to/repo" }
        ]
      ]
    }
  ]
}
```

Each inner array in `agent` is one group — a Dev/QA pair that works the repo together. `host` is only needed for remote agents. See [`baxian.json.example`](https://github.com/baxian-ai/baxian/blob/main/baxian.json.example) for a fuller example including remote agents. Everything is also editable from the web console (projects, agents, hosts, language, notifications) — the UI tells you when a change needs a server restart.

Useful options:

| Key | What it does |
| --- | --- |
| `language` | UI language, `en-US` (default) or `zh-CN` |
| `review.rounds` | Cap on review rounds before a task is parked as `max_rounds` |
| `review.mode` | `github` (default): reviews on real pull requests; `server`: built-in protocol for PR-less setups; can be set per project |
| `server.token` | Bearer token protecting the API and web console |
| `project[].merge` | `"auto"`: baxian merges the PR itself once you confirm the approved task; `null`: merge by hand |
| `project[].specApproval` | `"human"`: after QA approves a spec, park at `spec-ready` for your sign-off; `null` (default): QA approval moves straight to coding |
| `project[].agent[][].mode` + `host` | `local`, or `remote` with a host id for SSH-managed agents |

## License

[Apache-2.0](https://github.com/baxian-ai/baxian/blob/main/LICENSE)
