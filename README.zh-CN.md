<div align="center">

<img src="https://raw.githubusercontent.com/baxian-ai/baxian/main/assets/logo/baxian.png" alt="baxian logo" width="96">

# baxian

**你的 AI Agent Team——Dev agent 负责实现，QA agent 负责评审，每处改动过审后才交付。**

[English](https://github.com/baxian-ai/baxian/blob/main/README.md) · **简体中文**

[快速开始](#快速开始) · [功能特性](#功能特性) · [工作流](#工作流) · [工作原理](#工作原理) · [配置](#配置)

[![npm](https://img.shields.io/npm/v/baxian)](https://www.npmjs.com/package/baxian)
[![CI](https://github.com/baxian-ai/baxian/actions/workflows/test.yml/badge.svg)](https://github.com/baxian-ai/baxian/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/baxian-ai/baxian/blob/main/LICENSE)

<img src="https://raw.githubusercontent.com/baxian-ai/baxian/main/assets/screenshots/dashboard.webp" alt="baxian 控制台——Dev 与 QA agent 的实时终端墙" width="920">

</div>

## 为什么是 baxian

baxian 给每个 **Dev agent** 配一个独立的 **QA agent**：Dev 实现并提交 pull request，QA 以旁观者视角评审，「评审意见 → 修复」的循环自动推进，直到改动被通过。

baxian 是 **tmux 原生**的。一个 agent 就是 tmux session 里的一个交互式 Claude Code 或 Codex 会话——浏览器里看到的终端就是真实的 pane，随时可以在 shell 里 `tmux attach` 进同一个会话。关掉浏览器，舰队照常干活。

## 功能特性

- **终端墙** —— 控制台内嵌每个 agent 的实时终端（WebSocket 推流、xterm.js 渲染）。点击任意窗格即可向真实会话输入，无需切换窗口就能看清每个 agent 在做什么。
- **自动评审循环** —— QA 在 pull request 上发布评审意见，Dev 逐条修复并给出提交，或说明拒绝理由，再由 QA 复审，循环直到结论为 `approve`。
- **评审发生在真实的 PR 上** —— 每任务一个分支、自动建 PR、通过平台自己的 CLI（GitHub 用 `gh`，需另行安装并认证）轮询评审动态；项目设置 `merge: "auto"` 时，任务通过并经你确认后由 baxian 代为合并 PR。
- **Spec 人审门禁（可选）** —— 项目配置 `specApproval: "human"` 后，走规格稿路线的任务在 QA 通过规格稿时停驻在 `spec-ready`，等你签字确认才开始编码。
- **本地与远程 agent** —— agent 可以跑在任何 SSH 可达的机器上，远端 tmux 会话由 baxian 代管。
- **不需要 API key** —— agent 运行的是交互式 Claude Code / Codex CLI，凭证只有你已有的订阅账号。
- **周边体验** —— 双语界面（English / 简体中文）、任务完成浏览器通知、向 agent 终端直接上传图片，以及可选的像素风 agent 宠物。

## 工作流

1. 在 Web 控制台**创建任务**（也可以在命令行用 `baxian task create`）。
2. **Dev agent** 接手：开分支、实现、测试、提 pull request。
3. **QA agent** 独立评审 diff，提交评审意见。
4. Dev agent 逐条回应——修复，或说明理由拒绝——然后推送。
5. 循环直到 **approve**。你确认结果后 PR 被合并——项目设了 `merge: "auto"` 就由 baxian 代劳，否则手动合并。

<p align="center">
<img src="https://raw.githubusercontent.com/baxian-ai/baxian/main/assets/screenshots/task-detail.webp" alt="任务详情——状态、PR 与完整评审记录" width="820">
</p>

每一轮都有记录、可回看——QA 的评审意见，以及 Dev 带着提交的逐条回应。

## 工作原理

```
   浏览器（React + xterm.js）
        │  REST + WebSocket
        ▼
   baxian server（Node + Fastify）
   任务状态 · PR 时间线 · 平台 poller
        │  tmux send-keys / capture-pane
        ├────────────────┐
        ▼                ▼ SSH
   本地 tmux         远程 tmux（任意主机）
   dev-1 · qa-1      dev-2 · qa-2
```

server 持有任务和 agent 绑定状态，通过 tmux pane 驱动 agent，并从平台 PR 跟进评审反馈。

## 环境要求

> - **Node.js ≥ 22.13**
> - 每台跑 agent 的机器（本地与远程）都装有 **tmux**
> - **Claude Code**（`claude`）和/或 **Codex**（`codex`）CLI 已安装并登录
> - **git**，以及仓库平台所需的 CLI —— GitHub 仓库用已认证的 **GitHub CLI**（`gh`）；其它平台需自备 CLI 并在 `~/.baxian/plugins/` 下安装对应的驱动插件
>
> 该 CLI 需要在每台跑 agent 的机器上、以及 server 本机都完成认证：server 用它轮询评审、合并与关闭 PR，agent 用它开 PR 与发评论。

## 快速开始

```sh
npm install -g baxian
baxian
```

打开 <http://localhost:3000>。首次运行会自动创建 `~/.baxian/config.json`。

然后在控制台里：

1. **新建项目** —— 指向一个 git 仓库。
2. **添加 agent** —— 一个 Agent Team（例如 Claude Code 当 Dev、Codex 当 QA），各自的工作目录里放一份仓库的 clone。
3. **新建任务** —— 描述你要做什么；Dev agent 接手后，评审循环自动接管。

### CLI

```sh
baxian                    # 启动 server（默认命令）
baxian status             # 查看所有 agent 状态
baxian attach <agent-id>  # 接入 agent 的 tmux 会话（本地或远程）
baxian stop <agent-id>    # 打断一个 agent
baxian task create -p <project> -t "标题" -a <dev-id> [-d "描述"]
baxian task list -p <project>
```

## 配置

baxian 优先读取工作目录下的 `./baxian.json`，找不到时回退到 `~/.baxian/config.json`（`baxian start -c <path>` 可覆盖两者）。最小配置：

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

`agent` 里的每个内层数组是一个 Agent Team——协作同一仓库的一个 Dev agent 加一个 QA agent；`host` 只在使用远程 agent 时需要。更完整的示例（含远程 agent）见 [`baxian.json.example`](https://github.com/baxian-ai/baxian/blob/main/baxian.json.example)。这些配置也都能在 Web 控制台里修改（项目、agent、主机、语言、通知）——需要重启 server 的改动，界面会明确提示。

常用配置项：

| 配置项 | 作用 |
| --- | --- |
| `language` | 界面语言，`en-US`（默认）或 `zh-CN` |
| `review.rounds` | 评审轮数上限，超过后任务标记为 `max_rounds` 暂停 |
| `server.token` | 保护 API 与 Web 控制台的 Bearer token |
| `project[].merge` | `"auto"`：任务通过并经你确认后，由 baxian 代为合并 PR；`null`：手动合并 |
| `project[].specApproval` | `"human"`：QA 通过规格稿后停驻 `spec-ready` 等你确认；`null`（默认）：QA 通过即进入编码 |
| `project[].gitCli.tool` | 由哪个平台 CLI 驱动 PR 评审。GitHub 仓库自动解析为 `gh`；其它平台必须声明，并安装对应的驱动插件 |
| `project[].agent[][].mode` + `host` | `local` 本地运行，或 `remote` 配主机 id 走 SSH 代管 |

## 许可证

[Apache-2.0](https://github.com/baxian-ai/baxian/blob/main/LICENSE)
