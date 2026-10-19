# DevPilot

**让 ChatGPT / MCP Host 安全连接你的本地开发环境，并保留完整的本地可观测与控制能力。**

DevPilot 是基于 [Waishnav/devspace](https://github.com/Waishnav/devspace) 的 **upstream-first overlay**：上游 DevSpace 负责 MCP 工具、Workspace、Worktree、进程会话、Subagent、Skills、Artifacts 与 Change Review；DevPilot 只叠加少量本地产品能力，因此可以持续跟随上游，而不是维护第二套工具架构。

当前重点平台：**Windows 10/11 + PowerShell 5.1+ + Node.js >=22.19 <27**。

## DevPilot 增加了什么

- 本地 **Control Center**：总览、启动/重启/停止、Provider 状态、配置、最近事件。
- **ChatGPT 请求观察器**：按 `openai/session` 分组查看 `server/discover`、`tools/list`、`tools/call`、工具名、状态和耗时。
- **双 Tunnel 模式**：Cloudflare Quick Tunnel 与 OpenAI Secure MCP Tunnel，启动前可交互选择。
- OpenAI Secure MCP Tunnel 生命周期管理与 READY 健康检查。
- Windows 一键启动/关闭入口，启动后会等待真实 READY、打印连接信息并自动打开 Control Center。
- 高保真图片读取：普通图片尽量保持原分辨率；超大图片自动返回总览 + 2×2 细节切片，适合大型 UI、Minecraft/GTNH、图纸等场景。
- 少量 Windows/provider 可用性修正。
- **持久 Goal / 跨对话恢复**：将任务状态和验收证据持久化，配合有界的恢复上下文索引。
- **稳定性诊断与进程会话管理**：连接诊断、批量命令短等待、闲置 session 自动回收、可选 `detach` 和非交互式 SSH/SCP。

## 当前 MCP 工具

DevPilot 默认直接使用上游的 `codex` tool surface：

```text
open_workspace
read
show_changes
apply_patch
exec_command
write_stdin
workspace_turn
```

`exec_command` 的长任务会返回 `session_id`，随后由 `write_stdin` 继续轮询或交互；不再维护旧版 `grep/glob/ls/bash` 等第二套 Codex 工具面。

`workspace_turn` 用于已经能一次规划清楚的批量操作：最多把 8 个 `read`、短命令或进程轮询放进一次 MCP 往返。需要根据上一步结果临时决定下一步时，仍应使用独立工具调用。`open_workspace` 会缓存同一会话的 Bootstrap Context；只有显式传入 `refresh_context=true` 才强制重新加载 AGENTS、Skills 与嵌套指令发现。

也可以在 Control Center 中切换到上游 `claude` surface：

```text
open_workspace
read
show_changes
write
edit
bash
```

## 快速开始

### 完全权限模式（Full Access）

DevPilot 默认只允许在 `allowedRoots` 所列目录中打开工作区。若你需要在自己的电脑上操作桌面或任意盘符，可以在本地 Control Center 的**设置 → 本机文件权限**里选择**完全权限模式**，阅读风险确认后保存并重启 MCP 服务。

开启后，已授权的 MCP 客户端能够以**当前 Windows 用户身份**打开任何该账户可访问的目录；不会自动获得管理员权限，也不会突破系统 ACL、第三方平台审核或远程 SSH 的独立认证。受限目录列表会原样保存，日后切回受限模式无需重新配置。**不要把完全权限的 MCP 连接分享给不受信任的用户或公开暴露认证凭据。**

如果使用 JSONC 配置管理，也可在私有 `config.jsonc` 中设置 `workspaces.permissionMode` 为 `"full"`（恢复时改回 `"restricted"`），重启生效。

### Windows 便携安装包（无需自行安装 Node.js）

在 [GitHub Releases](https://github.com/1210350468/devpilot/releases) 下载与你信任的版本对应的
`DevPilot-windows-x64-vX.Y.Z.zip`，解压后双击 **`首次配置-DevPilot.cmd`**。
安装向导会帮助你选择授权工作目录与 Cloudflare/OpenAI Tunnel 模式，随后完成健康检查。
ZIP 内含 Node.js 和 Windows 原生依赖，**无需另外安装 pnpm**。请下载并保留同名 `.sha256` 校验文件以验证压缩包完整性。

安全说明：便携 ZIP 暂不内置 Pi Agent 的原生受限沙箱依赖（上游尚有未修复的 `node-forge` 漏洞）；Pi 受限执行会拒绝启动而不会降级为无沙箱模式。Codex/Claude/MCP 主功能不受影响。详见 [Windows 发布与更新说明](docs/windows-distribution.md)。

目前源码仓库提供的是构建与 Release 自动化功能，**只有 GitHub Releases 页面实际出现 ZIP 时才能下载便携版**。
当前版本还没有发行 ZIP 的话，请使用下文源码安装。

便携版以后需要更新时，先正常关闭 DevPilot，再运行 `更新-DevPilot.cmd`，它会检查新版本、
下载 ZIP、验证 SHA256、迁移私有配置与 Goal/Worktree 状态，并保留完整旧版目录供回滚。
Control Center 的“版本与更新”面板也提供按需检查，不会自动替你停止活跃 MCP 任务。
具体流程见 [Windows 发布与更新说明](docs/windows-distribution.md)。

### 0. 交给 AI Agent 辅助安装（推荐新手）

不熟悉 Git、Node.js、MCP 或 Windows 配置？可以把下面这段话**原样复制给能操作本机终端的 Codex、Claude Code 或其他可信编程 Agent**。它会按步骤检查、安装、启动并验收，而不是让你盲跑一段远程脚本。

> **注意：** Agent 必须获得你允许的本机终端权限才能实际安装；ChatGPT 普通对话本身不会自动操作你的电脑。首次创建 ChatGPT MCP/App 连接和任何私密授权仍可能需要你手动确认。

```text
请帮我在 Windows 10/11 上安装并验证 DevPilot（官方仓库：https://github.com/1210350468/devpilot）。
先阅读仓库 README.md 和 docs/agent-install-prompt.md，并按其中的安全、检查、构建、启动与验收流程执行。
目标是让我能够在 ChatGPT 中通过 MCP 操作我授权的本地项目。优先选择不需要私有 Tunnel 凭据的 Cloudflare Quick Tunnel；
如果我明确已有 OpenAI Secure MCP Tunnel，再协助使用本地私有配置，不要要求我在聊天里粘贴任何密钥。
执行前检查现有 DevPilot 进程/端口和安装目录，禁止覆盖或杀掉已有实例；
完成后确认 MCP、Tunnel 和 Control Center 真正 READY，告诉我如何在 ChatGPT 中连接，并用只读工具调用做一次验收。
不要全局更改代理、SSH/Git 凭据或开放整个磁盘；遇到需要我授权的步骤，明确指出并停在该步骤。
```

完整的可复制提示词、已有安装升级流程和验收清单：**[docs/agent-install-prompt.md](docs/agent-install-prompt.md)**。
如果 Agent 只会写说明而不能访问本机，按下文手动安装即可。

### 1. 克隆并构建

```powershell
git clone https://github.com/1210350468/devpilot.git
cd devpilot
# 如果要使用 Goal / 新的 session 生命周期等候选功能：
# 先确认 GitHub 上已发布该候选分支，再执行：
# git switch candidate/persistent-workspace-channel-v1
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

> 本仓库当前只发布 GitHub 源码，不发布或覆盖上游的 npm 包。`package.json` 保留上游内部包名以减少兼容风险，并设置了 `private: true` 防止误发布。

### 2. 配置 OpenAI Secure MCP Tunnel（可选）

如果使用 Cloudflare Quick Tunnel，不需要提前配置 OpenAI Tunnel；启动器会自动查找或下载官方 `cloudflared`。

如果使用 OpenAI Secure MCP Tunnel，需要一个本地私有配置：

```text
.devpilot-config/openai-tunnel.json
```

示例：

```json
{
  "tunnelId": "tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "runtimeApiKey": "YOUR_RUNTIME_API_KEY",
  "controlPlaneProxy": "http://127.0.0.1:7890"
}
```

`controlPlaneProxy` 可省略。**不要提交这个文件，也不要把 Runtime API Key 发到聊天或日志里。** `.devpilot-config/` 已被 Git 忽略。

Tunnel client 可通过任一方式提供：

- `tools/tunnel-client.exe`
- 系统 `PATH` 中的 `tunnel-client`
- 环境变量 `DEVPILOT_OPENAI_TUNNEL_CLIENT`

也可以用 `DEVPILOT_OPENAI_TUNNEL_CONFIG` 指向其他本地 tunnel 配置文件。

如果你没有 OpenAI Secure MCP Tunnel，直接在启动菜单选择 **Cloudflare Quick Tunnel** 即可。启动器会等待真实公网 URL 生成后再判定 READY，并把完整 `/mcp` 地址复制到剪贴板。

### 3. 一键启动

Windows 双击：

```text
启动-DevPilot.cmd
```

启动器首先显示双模式菜单：

```text
  Cloudflare Quick Tunnel
> OpenAI Secure MCP Tunnel
```

使用 `↑ / ↓` 选择，`Enter` 启动，`Esc` 取消。随后启动器会：

1. 创建独立的 `.devpilot-config/` 与 `.devpilot-runtime/`；
2. 默认将仓库所在父目录作为第一个 allowed root；
3. 启动 upstream-first MCP server；
4. 根据选择启动 Cloudflare Quick Tunnel 或 OpenAI Secure MCP Tunnel；
5. 硬性等待 MCP + Tunnel 真正 READY，失败时保留窗口并显示错误；
6. 打印 Control Center、本地 MCP、公网 MCP URL 或 Tunnel ID、工具面、日志路径和 ChatGPT 下一步操作；
7. 把 Public MCP URL 或 Tunnel ID 复制到剪贴板；
8. 自动打开 Control Center。

成功窗口会停留到你按键关闭，不再一闪而过。只有看到 `DevPilot 已启动 · READY` 才表示 GPT 侧应该可用。

默认测试端口：

| 用途 | 地址 |
| --- | --- |
| Control Center | `http://127.0.0.1:47680/devpilot/` |
| MCP | `http://127.0.0.1:47681/mcp` |
| Tunnel health | `http://127.0.0.1:47683/readyz` |

关闭：

```text
关闭-DevPilot.cmd
```

旧的 `启动-DevPilot-Upstream.cmd` / `关闭-DevPilot-Upstream.cmd` 仍保留为兼容入口。

## ChatGPT 怎么接

连接方式取决于启动模式：

- **OpenAI Secure MCP Tunnel**：使用绑定该 Tunnel ID 的 MCP/App connector。第一次从旧版 DevPilot 升级时，建议新建一个 connector 名称，因为 ChatGPT 可能缓存旧工具 schema。
- **Cloudflare Quick Tunnel**：把启动器打印并复制到剪贴板的 `https://...trycloudflare.com/mcp` 作为 Remote MCP URL。

连接成功后，新对话应该发现：

```text
open_workspace
read
show_changes
apply_patch
exec_command
write_stdin
workspace_turn
```

示例：

```text
打开 E:\coding\my-project，先阅读 README 和项目记录，只分析当前状态，不修改。
```

修改后可以让模型调用 `show_changes` 查看统一的变更审阅卡。

## Control Center

启动后打开：

```text
http://127.0.0.1:47680/devpilot/
```

目前包括：

- **总览**：MCP / Tunnel / Tool Surface / Provider / 运行事件。
- **请求观察器**：按 ChatGPT 对话查看 discovery、tool call、工具名、状态与耗时。
- **设置**：allowed roots、`codex/claude` tool surface、Artifacts、Skills、Subagents、请求/工具日志、Public Base URL。
- **版本与更新**：手动检查 GitHub Releases 的稳定版或预览版，展示当前版本与新版发行链接；不会自动覆盖运行中的实例。
- 顶部运行控制：启动、重启、停止。

保存设置并重启时，Supervisor 会重新读取配置文件，不会只复用旧内存参数。

## 高保真图片读取

DevPilot 对上游 `read` 增加了图片增强：

- 小于约 4.5 MB 的图片：尽量保持原始分辨率传给模型。
- 更大的图片：提供一张总览，并附带左上、右上、左下、右下 4 个 JPEG 细节切片。
- 如果切片失败，安全降级为上游压缩总览。

这解决了大型截图被统一缩到较低分辨率后，模型无法辨认小字、管线、方块或 UI 细节的问题。

## 安全边界

DevPilot / DevSpace 能让远程 MCP Host 在允许的本地 Workspace 中读取、修改文件并运行命令，权限是真实的本机用户权限。

- 只将可信目录加入 `allowedRoots`。
- Shell/Process 不是完整沙箱。
- 不要提交 `.devpilot-config/`、`.devpilot-runtime/`、Runtime API Key、OAuth Token 或其他凭据。
- 一个 Secure Tunnel ID 不应同时由多个本地 tunnel-client 消费。DevPilot Supervisor 会为 Secure Tunnel 获取本机唯一 lease；第二个 DevPilot backend 使用同一 Tunnel ID 时会 fail-closed，而不是让 ChatGPT 请求随机落到不同 workspace 状态。
- 启动脚本默认只读取当前 checkout 的 `.devpilot-config/openai-tunnel.json`，不会再静默继承 ambient `DEVPILOT_OPENAI_TUNNEL_CONFIG`。如确实需要外部 Tunnel 配置，使用 `-OpenAiTunnelConfig <path>` 显式传入。
- Control Center 默认只监听 loopback。

## 开发与发布门

```powershell
pnpm install --frozen-lockfile
pnpm audit --prod
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
```

发布前必须在**要发布的确切提交**重新执行上述检查。旧版构建曾通过 package dry-run 和 Tunnel 端到端验证；这些结果不能自动证明新的提交通过同一轮验收。

最近候选分支的记录：**198 tests / 192 pass / 0 fail / 6 platform-or-optional skips**，TypeScript 与 production build 通过。依赖审计应以当前 `pnpm audit --prod` 为准，不继续沿用旧版“0 漏洞”的过时结论。GitHub `main`、候选分支和本机运行实例可能不是同一版本；部署前应检查 `git rev-parse --short HEAD` 与发布说明。

## 与上游 DevSpace 的关系

DevPilot 继续保留 DevSpace 的 MIT License，并把上游作为核心真值源：

```text
Waishnav/devspace upstream
        │
        ├─ MCP tool surfaces
        ├─ Workspace / Worktree
        ├─ Process sessions
        ├─ Subagents / Skills
        ├─ Artifacts / Review
        │
        └─ DevPilot thin overlay
           ├─ Control Center
           ├─ Request Observer
           ├─ OpenAI Secure MCP Tunnel
           ├─ Windows one-click launcher
           └─ high-fidelity image reads
```

上游项目：<https://github.com/Waishnav/devspace>

DevPilot 技术状态与 overlay 说明：[`docs/devpilot-upstream-overlay.md`](docs/devpilot-upstream-overlay.md)
