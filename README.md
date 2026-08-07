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

Coding agents are fast; the bottleneck is checking their work. baxian pairs every **Dev agent** with an independent **QA agent**: the Dev implements and opens a pull request, the QA reviews it with fresh eyes, and findings and fixes go back and forth automatically until the change is approved. You step in for the sign-offs: approving the plan when you've required that, and confirming the final result.

An agent is an interactive CLI — **Claude Code, Codex, OpenCode, or Qoder CLI** — running inside a tmux session. The terminal you see in the browser is that same session: `baxian attach <agent-id>` (or `tmux attach -t '=<agent-id>'` on the agent's machine) drops you into it, and closing the browser stops nothing.

## Features

- **Terminal wall** — the dashboard shows every agent's live terminal. Click a pane to type into the real session; what every agent is doing is always one glance away.
- **Automated review loop** — QA posts findings on the pull request, Dev fixes each one or rejects it with a reason, QA re-checks — until the verdict is approve.
- **Real pull requests** — each task gets its own branch and PR on your Git platform (GitHub built-in; other platforms via plugins), so reviews live where your team already works. With `merge: "auto"`, baxian merges the approved PR once you confirm.
- **Plan approval (optional)** — a task can start with a written plan instead of code. QA reviews the plan the same way, and with `specApproval: "human"` coding waits for your sign-off.
- **Local & remote agents** — run agents on any machine reachable over SSH; baxian manages the remote tmux sessions for you.
- **Model credentials stay in your CLIs** — baxian stores no model keys and configures none of its own; each agent uses whatever auth its CLI already has. Repository access (git plus your platform's CLI — `gh` for GitHub) is a separate prerequisite — see Requirements.
- **Quality of life** — bilingual UI (English / 简体中文), browser notifications when tasks finish, image upload straight into an agent's terminal, and optional pixel-art agent pets.

## The workflow

1. **Create a task** in the web console (or with `baxian task create`).
2. A **Dev agent** picks it up: branch, implementation, tests, pull request.
3. A **QA agent** reviews the diff independently and posts findings.
4. The Dev agent answers every finding — a fix and a commit, or a reasoned rejection — and pushes.
5. Repeat until **approve**. You confirm the result, and the PR is merged — by baxian if the project sets `merge: "auto"`, otherwise by hand.

<p align="center">
<img src="https://raw.githubusercontent.com/baxian-ai/baxian/main/assets/screenshots/task-detail.webp" alt="Task detail — status, PR, and the full review record" width="820">
</p>

Every round is recorded and browsable — QA's findings and Dev's responses, each with its commits.

## How it works

```
   Browser (React + xterm.js)
        │  REST + WebSocket
        ▼
   baxian server (Node + Fastify)
   task state · PR timeline · platform poller
        │  tmux send-keys / capture-pane
        ├────────────────┐
        ▼                ▼ SSH
   local tmux        remote tmux (any host)
   dev-1 · qa-1      dev-2 · qa-2
```

The server keeps task state, drives each agent by typing into its tmux pane, and follows review activity on the pull request of your Git platform.

## Requirements

> - **Node.js ≥ 22.13**
> - **tmux** on every machine that runs agents (local and remote)
> - The CLI of every runtime your agents use, installed and working on each machine that runs such an agent — signed in where its provider requires that: **Claude Code** (`claude`), **Codex** (`codex`), **OpenCode** (`opencode`), **Qoder CLI** (`qodercli`). One host running several runtimes needs each of their CLIs.
> - **git** access to your repository on every agent machine — push access for Dev agents; read is enough for QA. For private HTTPS repositories on GitHub, run `gh auth setup-git` on every agent host.
> - For projects on the built-in GitHub driver: an authenticated **GitHub CLI** (`gh`) on every agent machine (Dev opens PRs, QA posts reviews) and on the server, where it needs write access to the repository (it polls reviews, merges and closes PRs). Projects on a plugin platform follow that plugin's CLI and auth requirements instead.
>
> `baxian check <project>` checks tmux, the CLI binaries, git access, and platform CLI auth (`gh` for GitHub) for every agent. Static checks can't see everything — confirm yourself that each agent CLI starts and works with its configured model, that QA's platform credentials may write PR reviews, and that Dev's git credential can actually push (a read-only deploy key still passes the read probe).

## Quick start

```sh
npm install -g baxian
baxian
```

Open <http://localhost:3000>. The first run creates `~/.baxian/baxian.json` for you.

Then, in the console:

1. **New project** — point it at a repository on GitHub, or on any platform added by an installed plugin.
2. **Add agents** — an Agent Team (for example Claude Code as Dev, Codex as QA), each with a working directory that holds a clone of the repo.
3. **New task** — describe what you want; the Dev agent takes it from there.

### CLI

```sh
baxian                    # start the server (default command)
baxian --home <dir>       # use a separate instance home (or set BAXIAN_HOME)
baxian status             # status of all agents
baxian attach <agent-id>  # attach to an agent's tmux session, local or remote
baxian stop <agent-id>    # interrupt an agent
baxian check <project>    # preflight a project's agents (--fix installs missing tmux)
baxian task create -p <project> -t "title" -a <dev-id> [-d "description"]
baxian task list -p <project>
baxian task cancel <task-id>
baxian plugin install <pkg> [--registry <url>]  # download a platform plugin package (e.g. an internal Git platform); restart to activate
baxian plugin status          # installed platform plugins and whether they load
baxian plugin uninstall <pkg> # remove a platform plugin; repositories only it recognized stop validating
```

## Configuration

baxian reads exactly one file: `<home>/baxian.json`, where `<home>` defaults to `~/.baxian` (override with `baxian --home <dir>` or `BAXIAN_HOME`; the CLI option wins). A minimal configuration:

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

Each inner array in `agent` is one Agent Team — a Dev and a QA that work the repo together. `runtime` accepts `claude-code`, `codex`, `opencode`, or `qodercli`; `host` is only needed for remote agents. See [`baxian.json.example`](https://github.com/baxian-ai/baxian/blob/main/baxian.json.example) for a fuller example including remote agents. Projects, agents, and hosts can also be managed from the web console (along with UI language and notifications), and it tells you when a change needs a server restart; the remaining options are edited in the file.

Useful options:

| Key | What it does |
| --- | --- |
| `language` | UI language, `en-US` (default) or `zh-CN` |
| `review.rounds` | Review-round cap; when a change would still need another round past it, the task pauses as `max_rounds` |
| `server.token` | Bearer token protecting the API and web console |
| `project[].merge` | `"auto"`: baxian merges the approved PR once you confirm; `null`: merge by hand |
| `project[].specApproval` | `"human"`: a plan needs your approval before coding starts (the web console preselects this); `null` or omitted in the file: coding starts as soon as QA approves the plan |
| `project[].agent[][].mode` + `host` | `local`, or `remote` with a host id for SSH-managed agents |

## License

[Apache-2.0](https://github.com/baxian-ai/baxian/blob/main/LICENSE)
