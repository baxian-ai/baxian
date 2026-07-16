# AGENTS GUIDANCE
## Behavioral Rules (Always Enforced)
- 使用中文交流。
- Do what has been asked; nothing more, nothing less.
- NEVER create files unless they're absolutely necessary for achieving your goal.
- ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested.
- NEVER commit secrets, credentials, or .env files.
- 凡事有交代，件件有着落，事事有回音。
- 遇到任何错误、警告或异常，必须正视并给出解决方案，禁止以"不影响"为由忽视或跳过。
- 本项目以 AGENTS.md 作为规则源文件，CLAUDE.md 统一用 symlink 指向 AGENTS.md（ln -s AGENTS.md CLAUDE.md）。
- 项目级别的规则记录在根目录的 AGENTS.md 中，各级目录中也可能有 AGENTS.md 文件用于约定该目录级别的规则。

## Develop Rules
- 技术方案必须充分考虑简洁性和可持续扩展性，思考清楚后再执行具体的开发。
- 如非必要，尽量减少外部依赖。
- 遵循第一性原理：每个实体、组件应有且仅有一个明确的职责，避免混合不同关注点。
- 必须特别谨慎地引入新概念，如非必要不得随意引入新的概念。系统中已有的概念能覆盖的场景，不要新造名词或实体。
- 决定技术方案前，必须先检索互联网，参考总结社区里的先进经验来制定方案。

## Destructive Operation Rules
- 对所有权无法证明的目标，破坏性操作（`rm -rf`、kill、覆盖非 baxian 产物）必须有用户的二次确认。自动化流程中禁止出现无确认的破坏性分支：遇到需要破坏的场景，一律停止并上报（intervention / awaiting_human / 抛错等待重试），把执行权交还给用户。
- 豁免一：同一流程内回滚自己刚创建、尚未移交的资源。凭据必须在删除时刻仍然成立且不可被路径/名字重绑定：唯一命名（含随机 token）的 staging 目录/tmp 文件按名删零竞态；tmux 会话凭据须由创建动作原子返回并绑定 server 世代（session id 会在 tmux server 重启后从 `$0` 复用，故 kill 必须以服务器端条件命令核验 `pid`+`start_time` 后执行），且回滚决策与接管宣告须经同一进程内串行化（检测与宣告同临界区）。出现任何移交信号后不再适用；证据不足时保留目标并告警。
- 豁免二：例行管理有可验证凭据证明归 baxian 所有的运行时产物，包括清理与原子覆盖：`.baxian/` 运行时目录内容、物化的 `baxian-*` skills（以 skill registry 为准）、claim（`@baxian-agent-id`）与凭据同快照取得的 tmux 会话、各 state store 按 id 管理的状态文件。凭据校验失败或探测失败时一律保留，不得降级为"按名字/路径删"。原子覆盖（tmp → `mv -f`）对目录目标会退化为 move-into，必须前置"目标非目录"校验（零副作用 fail closed）、以"目标为常规文件"校验收尾，失败时按唯一名清扫原路径与嵌套路径两处。Workdir 内的写入（staging tmp）与破坏性 rm/mv 同等对待：必须在同一 shell 命令内前置校验从 Workdir（含 Workdir 自身）到目标的祖先链非 symlink，失败清扫也必须带同样的 guard（宁泄漏 tmp 不越界删除）——这是把跨命令窗口压缩到单命令内的缓解（runner 与 agent 同 uid，无权限边界，防意外而非防恶意），不是消除。删除决策依赖的最后一个可变条件（如 claim 仍为空）应并入删除命令本身在服务器端原子评估，而非探测后另发一条 kill。
- 远程 exec 的结果判断必须三态化：肯定 / 否定 / 探测失败。SSH 超时、exit 255、任一流上出现瞬态网络特征，均不得当作"目标不存在"落入任何默认分支，必须中止本轮并等待重试。对可能已产生副作用的命令（创建 tmux 会话、mv），探测失败后必须按创建时原子注入的不可重绑定凭据（nonce 环境变量、唯一命名）做 reconciliation 判定"已执行/未执行"，不得默认"未执行"。命令失败以 resolve 的非零 exitCode 返回，`.catch` 逮不到它。
- 破坏性清理不得静默失败：删除/覆盖失败必须记录目标与原因（含 resolved 非零 exitCode），禁止 `.catch(() => undefined)` 式吞错；非例行删除（回滚、清理残骸）成功时也必须留痕。例行的状态文件删除与运行时产物覆盖以失败告警为准。

## Code Style Rules
- 禁止在代码中写大段注释。代码即注释，通过命名、结构、小函数让逻辑自解释。
- 默认不写注释。仅当 *Why* 非显然时（隐藏约束、不变量、surprising behaviour、与直觉不符的取舍）写一行短注。
- 不要把设计讨论写进代码。PR review 中的 rationale、A/B 决策、reviewer 反驳、对设计 addendum 的引述等，留在 PR 描述或 review 回复里。
- 不写 WHAT，只写 WHY。`// increments counter` 这种是噪音。
- 不写多行 docstring 解释设计决策。如果一个函数需要长篇解释才能理解，先考虑能否拆分或重命名使其自解释。

## File Naming Rules
- 全栈统一 kebab-case：所有源文件、测试文件、目录使用小写字母 + 连字符（`agent-card.tsx`、`task-store.ts`、`use-web-socket.ts`、`packages/server/src/agent/`）。React 组件、Hook、页面、工具一视同仁，不分文件类型。
- 单个英文单词文件保留 lowercase 即可（`runner.ts`、`prompt.ts`、`index.ts`、`types.ts`、`main.tsx`、`app.tsx`），不强制加连字符。
- 文件名与导出符号解耦：导出符号沿用各自语言/框架惯例（React 组件 PascalCase、Hook camelCase、常量 UPPER_SNAKE_CASE），文件名不必跟随。例：`agent-card.tsx` 导出 `AgentCard`，`use-web-socket.ts` 导出 `useTerminalSocket`。
- 配置文件遵循上游工具默认命名（`vite.config.ts`、`vitest.config.ts`、`tsconfig.json`、`package.json`、`AGENTS.md`），不改写。
- 理由：跨平台一致（macOS APFS 默认大小写不敏感，PascalCase 文件易在 Linux CI 与 macOS 本地间出 bug）、URL/CLI/路由友好、消除同目录混合风格的认知负担。社区现代 TypeScript/React 项目（shadcn/ui、Bulletproof React、Anthropic SDK、Hono、Bun）的主流选择。

## Test Rules
- 每次改动代码后必须在本地跑单元测试，确认没有破坏原有功能后再 commit + push。
- 不能以"本地没有环境"为由跳过，必须先探索验证。
- 每次改动必须补充对应的测试用例，涵盖 Happy path 和边界情况。

## Git Rules
- 采用分支开发模式：禁止直接向 main 提交代码，所有变更必须通过新建分支 + PR 合并
- 声称"已修复"或"已完成"之前，必须先 commit + push，确保代码已推送到远端分支。禁止代码尚未推送就在 PR 评论或消息中宣布完成。
- 分支合并到远程 main 后，本地也要删除该分支并切回 main。
- 新任务开新分支，分支名称要有意义（如 feat/upload-progress、fix/auth-token-refresh）。
- 对现有未合并分支的优化不要新开分支，继续在原分支上工作。
