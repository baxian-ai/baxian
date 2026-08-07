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

AI 写代码很快，瓶颈在于检查它写得对不对。baxian 给每个 **Dev agent** 配一个独立的 **QA agent**：Dev 实现并提交 pull request，QA 以旁观者视角评审，「评审意见 → 修复」自动往返，直到改动通过。需要你出手的是签字环节：启用方案确认时批准方案，最后确认结果。

agent 本体是一个交互式 CLI——**Claude Code、Codex、OpenCode 或 Qoder CLI**——跑在 tmux 会话里。浏览器里看到的终端就是那个真实会话：用 `baxian attach <agent-id>`（或在 agent 所在机器上 `tmux attach -t '=<agent-id>'`）就能进到同一个会话；关掉浏览器，agent 照常干活。

## 功能特性

- **终端墙** —— 控制台展示每个 agent 的实时终端，点击任意窗格就能直接输入；每个 agent 在做什么，一眼可见。
- **自动评审循环** —— QA 在 pull request 上提出评审意见，Dev 逐条修复或说明理由拒绝，QA 复审——循环直到结论为通过。
- **真实的 pull request** —— 每个任务一个分支、一个 Git 平台上的 PR（内置 GitHub，其他平台走插件），评审就发生在团队日常工作的地方。项目设置 `merge: "auto"` 时，任务通过并经你确认后由 baxian 代为合并。
- **方案确认（可选）** —— 任务可以先产出方案再动手写码，方案同样经过 QA 评审；配置 `specApproval: "human"` 后，方案要等你批准才开始开发。
- **本地与远程 agent** —— agent 可以跑在任何 SSH 可达的机器上，远端 tmux 会话由 baxian 代管。
- **模型凭证不经 baxian** —— baxian 不保存、也不重复配置任何模型凭证；agent 用的就是各 CLI 已有的认证与模型配置。仓库访问（git 与所选平台的 CLI，GitHub 为 `gh`）另有要求，见环境要求。
- **周边体验** —— 双语界面（English / 简体中文）、任务完成浏览器通知、向 agent 终端直接上传图片，以及可选的像素风 agent 宠物。

## 工作流

1. 在 Web 控制台**创建任务**（也可以用 `baxian task create`）。
2. **Dev agent** 接手：开分支、实现、测试、提 pull request。
3. **QA agent** 独立评审 diff，提出评审意见。
4. Dev agent 逐条回应——修复并提交，或说明理由拒绝——然后推送。
5. 循环直到**通过**。你确认结果后 PR 被合并——项目设了 `merge: "auto"` 就由 baxian 代劳，否则手动合并。

<p align="center">
<img src="https://raw.githubusercontent.com/baxian-ai/baxian/main/assets/screenshots/task-detail.webp" alt="任务详情——状态、PR 与完整评审记录" width="820">
</p>

每一轮都有记录、可回看——QA 的评审意见和 Dev 的逐条回应，以及对应的提交。

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

server 记录任务状态，通过向 tmux pane 输入来驱动 agent，并在所用 Git 平台的 PR 上跟进评审动态。

## 环境要求

> - **Node.js ≥ 22.13**
> - 每台跑 agent 的机器（本地与远程）都装有 **tmux**
> - 每个 agent 所选 runtime 的 CLI 都已在其所在机器安装、并能正常运行（provider 需要认证的先完成认证）：**Claude Code**（`claude`）、**Codex**（`codex`）、**OpenCode**（`opencode`）、**Qoder CLI**（`qodercli`）；同一台机器跑多种 runtime，就要装齐对应的全部 CLI
> - 每台 agent 机器都能用 **git** 访问仓库——Dev agent 需要推送权限，QA 只读即可。GitHub 私有 HTTPS 仓库需在每台 agent 主机上执行 `gh auth setup-git`。
> - 使用内置 GitHub 驱动的项目：每台 agent 机器上已认证的 **GitHub CLI**（`gh`）——Dev 用它开 PR、QA 用它发评审；server 本机的 `gh` 需要仓库写权限（轮询评审、合并与关闭 PR）。使用插件平台的项目改为遵循对应插件的 CLI 与认证要求。
>
> 运行 `baxian check <project>` 可检查各 agent 的 tmux、CLI 二进制、git 访问与平台 CLI 登录（GitHub 为 `gh`）。静态检查无法覆盖一切，请自行确认：各 agent CLI 能以所配模型正常启动、QA 的平台凭证可发布 PR review、Dev 的 git 凭证确实能 push（只读 deploy key 也能通过读探测）。

## 快速开始

```sh
npm install -g baxian
baxian
```

打开 <http://localhost:3000>。首次运行会自动创建 `~/.baxian/baxian.json`。

然后在控制台里：

1. **新建项目** —— 指向一个 GitHub 仓库，或任何已装插件所支持平台上的仓库。
2. **添加 agent** —— 一个 Agent Team（例如 Claude Code 当 Dev、Codex 当 QA），各自的工作目录里放一份仓库的 clone。
3. **新建任务** —— 描述你要做什么，剩下的交给 Dev agent。

### CLI

```sh
baxian                    # 启动 server（默认命令）
baxian --home <dir>       # 使用独立实例 home（也可设置 BAXIAN_HOME）
baxian status             # 查看所有 agent 状态
baxian attach <agent-id>  # 接入 agent 的 tmux 会话（本地或远程）
baxian stop <agent-id>    # 打断一个 agent
baxian check <project>    # 逐项检查项目内各 agent 的环境（--fix 自动安装缺失的 tmux）
baxian task create -p <project> -t "标题" -a <dev-id> [-d "描述"]
baxian task list -p <project>
baxian task cancel <task-id>
baxian plugin install <pkg> [--registry <url>]  # 下载平台插件包（如内部 Git 平台），重启 server 生效
baxian plugin status          # 查看已安装平台插件及其加载状态
baxian plugin uninstall <pkg> # 卸载平台插件；仅它识别的仓库地址将不再通过校验
```

## 配置

baxian 只读取一个配置文件：`<home>/baxian.json`，`<home>` 默认为 `~/.baxian`（可用 `baxian --home <dir>` 或 `BAXIAN_HOME` 覆盖，CLI 参数优先）。最小配置：

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

`agent` 里的每个内层数组是一个 Agent Team——协作同一仓库的一个 Dev 加一个 QA。`runtime` 可选 `claude-code`、`codex`、`opencode`、`qodercli`；`host` 只在使用远程 agent 时需要。更完整的示例（含远程 agent）见 [`baxian.json.example`](https://github.com/baxian-ai/baxian/blob/main/baxian.json.example)。项目、agent、主机也可以在 Web 控制台里创建和管理（界面语言与通知同样在控制台设置），需要重启 server 的改动界面会明确提示；其余配置项直接编辑配置文件。

常用配置项：

| 配置项 | 作用 |
| --- | --- |
| `language` | 界面语言，`en-US`（默认）或 `zh-CN` |
| `review.rounds` | 评审轮数上限；最后允许的一轮之后仍需修改时，任务以 `max_rounds` 暂停 |
| `server.token` | 保护 API 与 Web 控制台的 Bearer token |
| `project[].merge` | `"auto"`：任务通过并经你确认后由 baxian 合并 PR；`null`：手动合并 |
| `project[].specApproval` | `"human"`：方案需你批准后才开始开发（Web 控制台新建项目时默认选中）；配置文件中省略或填 `null`：QA 通过方案即开始开发 |
| `project[].agent[][].mode` + `host` | `local` 本地运行，或 `remote` 配主机 id 走 SSH 代管 |

## 许可证

[Apache-2.0](https://github.com/baxian-ai/baxian/blob/main/LICENSE)
