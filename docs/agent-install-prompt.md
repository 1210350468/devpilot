# DevPilot：AI Agent 辅助安装与验收提示词

这是一份供 **Codex、Claude Code、Cursor 等具有本机命令执行能力的 Agent** 使用的安装说明。目标是让新用户复制一段提示词，就能由 Agent 逐步处理环境检查、源码获取、构建、启动和本地验收。**不是**无审查的一行命令，也不能代替用户在 ChatGPT 中完成首次连接授权。

仓库：<https://github.com/1210350468/devpilot>

当前重点支持 **Windows 10/11 + PowerShell 5.1+ + Git + Node.js >=22.19 <27**，使用仓库指定的 pnpm。Linux/macOS 用户请先核实兼容性，不要假设 Windows 启动器适用。

## 复制给 Agent

```text
你是我的 DevPilot 本机安装与验收助手。请直接执行能安全完成的步骤，并逐项报告结果，不要只提供一份未经执行的安装教程。

软件来源： https://github.com/1210350468/devpilot
目标：在我的 Windows 10/11 电脑安装、构建并启动 DevPilot，让 ChatGPT/MCP Host 可以访问我明确允许的工作目录。

约束及步骤：
1. 先确认操作系统、PowerShell、Git、Node.js 版本、Corepack/pnpm，以及我希望的安装目录。读取仓库 README.md、package.json 和启动脚本再操作。如果软件已经安装，先确定仓库路径、运行端口、正在使用的 Tunnel ID、Git 工作树是否干净；不得直接覆盖已有本地修改。
2. 检查现有 DevPilot、MCP、Tunnel、Control Center 进程和端口。不要停止、覆盖、夺取另一实例的 Secure Tunnel ID。发现冲突时列出实例、PID、端口和安全可行的方案，未经确认不做破坏性切换。
3. 若尚未安装，克隆指定的官方仓库到我同意的目录。检查实际 branch/HEAD 与 README 是否匹配；若需要候选版的新功能，先确认候选分支已在 GitHub 发布，不能因为聊天描述而假设 main 已包含这些功能。
4. 用仓库指定的 pnpm 版本执行 pnpm install --frozen-lockfile、pnpm typecheck（如脚本可用）、pnpm build；构建失败先定位原因，不更改全局环境或安全设置来绕过故障。安装 Node/Git 等缺失工具如需管理员权限，先征得我的同意。
5. 优先使用 Cloudflare Quick Tunnel 进行首次演示。Secure MCP Tunnel 只在我明确拥有有效 Tunnel ID、runtime key 和 tunnel-client 时配置。私钥、Runtime API Key、OAuth Token 等只保存在本地被 Git 忽略的私有配置中；不要输出、复制到聊天、推送到 GitHub 或提交到代码仓库。
6. 对照 README 使用仓库提供的 Windows 启动器（启动-DevPilot.cmd），不要另造隐藏常驻任务或绕过启动器的健康检查。交互式菜单由我选择，或者在确定受支持的前提下采用现有的非交互启动选项。
7. 只授权我指明的 allowedRoots，不要默认开放整个 C:/D:/E: 盘，不修改系统代理、防火墙、Git 全局凭据、SSH 配置，也不要下载未经仓库验证的执行文件。
8. 启动后必须验证：本机 MCP 响应、Tunnel READY、Control Center 可打开、配置路径和日志可读取。区分本地健康与公网/ChatGPT 侧是否真能连接。仅在得到实际验证结果后宣称成功。
9. 告诉我下一步在 ChatGPT 的 Plugins/Apps/MCP 连接界面中需要做什么；Quick Tunnel 使用启动器实际生成的 HTTPS /mcp 地址，Secure Tunnel 使用实际绑定的连接。授权确认需我亲自完成，不要声称已替我完成平台侧注册。
10. 如果我已连接该 MCP，请用一个只读 open_workspace/read 调用验证允许目录的访问。不在首次验收中擅自修改业务文件、启动训练、开启后台守护或删除已有配置。
11. 完成后给出：安装目录、Git 分支/提交号、Node/pnpm 版本、构建/检查结果、Control Center 地址、MCP/Tunnel 模式与 READY 状态、ChatGPT 侧待人工完成的步骤，以及如何正常关闭（关闭-DevPilot.cmd）。
12. 如果任何关键步骤失败，停止后续部署，给出失败点、必要日志摘要和最小可行修复。不可伪造成功、吞掉错误或在失败后无限重试。

执行时遵守项目 AGENTS.md（如果存在）和 README.md 的更具体要求；不要泄露本机用户信息、路径下的私有数据或凭据。
```

## 手工安装命令（Windows PowerShell）

以下命令只负责克隆和构建，不会替你完成 ChatGPT 连接或启动 Tunnel：

```powershell
git clone https://github.com/1210350468/devpilot.git
cd devpilot
# 需要新版 Goal / session 管理时，且确认 GitHub 已发布对应分支：
# git switch candidate/persistent-workspace-channel-v1
node --version
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

确认没有与其他 DevPilot 实例冲突后，双击仓库里的 `启动-DevPilot.cmd`，选择所需 Tunnel 模式，等待 **READY**，再按 README 的“ChatGPT 怎么接”部分操作。

## 已安装用户的安全升级

1. 找到正在运行的 DevPilot 对应仓库与 **实际 origin**。它可能是本地 Git Bundle，而不是 GitHub。
2. 保存当前 `git status`、`git branch -vv`、`git remote -v`、`git rev-parse HEAD` 与本机运行版本。不要用 `git reset --hard` 消除未提交修改。
3. 确认 GitHub 的分支包含目标修复后，才选择 `git fetch` 与安全升级。必要时新建 worktree 进行验证，不在训练/实验期间盲目重启共享 MCP。
4. 安装并构建后，仅在明确了现有连接者和窗口后滚动重启对应实例，验证 Tunnel 不再被两个 backend 同时消费、已有 workspace/Goal 状态可恢复。
5. ChatGPT 旧对话可能缓存 MCP 工具 schema。服务器端修复通常立即生效，但若新增参数（如 `detach`、`non_interactive`）没有出现，可刷新插件连接或新开 Chat；不需要重装 MCP 或泄露 Tunnel 密钥。

## 验收不靠“窗口没报错”

| 验收项 | 成功标准 |
| --- | --- |
| 环境 | Git/Node/pnpm 版本与项目要求一致 |
| 构建 | 构建命令返回退出码 0 |
| MCP | 监听端口与请求健康检查正常 |
| Tunnel | 当前选择的模式真实 READY，有可用的连接方式 |
| ChatGPT | 用户完成授权后，能看到工具并进行只读调用 |
| 安全 | 没有泄露密钥、扩大 allowedRoots 或抢占旧实例 |
| 可回退 | 记录原分支/提交、配置备份位置与关闭方法 |

**提示词能够减少安装操作，不等于安装已经发生。** 最终以运行时健康检查和 ChatGPT 端真实调用为准。
