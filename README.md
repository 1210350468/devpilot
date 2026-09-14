# DevPilot

**让 ChatGPT / MCP Host 安全连接你的本地开发环境，并保留完整的本地可观测与控制能力。**

DevPilot 是基于 [Waishnav/devspace](https://github.com/Waishnav/devspace) 的 **upstream-first overlay**：上游 DevSpace 负责 MCP 工具、Workspace、Worktree、进程会话、Subagent、Skills、Artifacts 与 Change Review；DevPilot 只叠加少量本地产品能力，因此可以持续跟随上游，而不是维护第二套工具架构。

当前重点平台：**Windows 10/11 + PowerShell 5.1+ + Node.js >=22.19 <27**。

## DevPilot 增加了什么

- 本地 **Control Center**：总览、启动/重启/停止、Provider 状态、配置、最近事件。
- **ChatGPT 请求观察器**：按 `openai/session` 分组查看 `server/discover`、`tools/list`、`tools/call`、工具名、状态和耗时。
- **OpenAI Secure MCP Tunnel** 生命周期管理与 READY 健康检查。
- Windows 一键启动/关闭入口，启动后自动打开 Control Center。
- 高保真图片读取：普通图片尽量保持原分辨率；超大图片自动返回总览 + 2×2 细节切片，适合大型 UI、Minecraft/GTNH、图纸等场景。
- 少量 Windows/provider 可用性修正。

## 当前 MCP 工具

DevPilot 默认直接使用上游的 `codex` tool surface：

```text
open_workspace
read
show_changes
apply_patch
exec_command
write_stdin
```

`exec_command` 的长任务会返回 `session_id`，随后由 `write_stdin` 继续轮询或交互；不再维护旧版 `grep/glob/ls/bash` 等第二套 Codex 工具面。

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

### 1. 克隆并构建

```powershell
git clone https://github.com/1210350468/devpilot.git
cd devpilot
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

> 本仓库当前只发布 GitHub 源码，不发布或覆盖上游的 npm 包。`package.json` 保留上游内部包名以减少兼容风险，并设置了 `private: true` 防止误发布。

### 2. 配置 OpenAI Secure MCP Tunnel（可选 DevPilot 一键模式）

一键脚本需要一个可用的 OpenAI Secure MCP Tunnel client，以及本地私有配置：

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

如果你没有 OpenAI Secure MCP Tunnel，仍可直接使用上游 DevSpace 的 OAuth + Cloudflare/ngrok/Tailscale 等公开 HTTPS Tunnel 工作流；DevPilot overlay 不会移除这些上游能力。

### 3. 一键启动

Windows 双击：

```text
启动-DevPilot.cmd
```

启动器会：

1. 创建独立的 `.devpilot-config/` 与 `.devpilot-runtime/`；
2. 默认将仓库所在父目录作为第一个 allowed root；
3. 启动 upstream-first MCP server；
4. 启动 OpenAI Secure MCP Tunnel；
5. 等待 Tunnel READY；
6. 自动打开 Control Center。

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

创建一个新的 MCP/App connector 指向你的 Secure Tunnel。第一次从旧版 DevPilot 升级时，**建议新建一个 connector 名称**，因为 ChatGPT 可能缓存旧工具 schema。

连接成功后，新对话应该发现：

```text
open_workspace
read
show_changes
apply_patch
exec_command
write_stdin
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
- 一个 Secure Tunnel ID 不应同时由多个本地 tunnel-client 消费。
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

当前 upstream-first 发布候选已经验证：

- production dependency audit：**0 known vulnerabilities**
- tests：**139 total / 133 pass / 0 fail / 6 platform-or-optional skips**
- typecheck：PASS
- build：PASS
- package dry-run：PASS
- OpenAI Tunnel：READY
- Control Center：HTTP 200

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
