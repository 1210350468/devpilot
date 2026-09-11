# DevPilot

**让 ChatGPT 安全连接你的本地开发环境，并把详细 MCP 调用过程留在本地。**

DevPilot 是基于 [Waishnav/devspace](https://github.com/Waishnav/devspace) 的轻量增强版。它不替代 ChatGPT，也不再造一套 Agent Harness；它专注于三件事：

1. 提供本地中文 Control Center，集中管理 DevSpace / MCP / Tunnel 配置与状态。
2. 观察 ChatGPT → DevSpace 的 MCP 请求和工具调用，并按 `openai/session` 区分不同 ChatGPT 对话。
3. 提供 Windows 一键启动入口，在 Cloudflare Quick Tunnel 与 OpenAI Secure MCP Tunnel 之间切换。

> 当前重点平台：**Windows 11 + PowerShell 5.1+**。底层 DevSpace 仍保留原有跨平台能力，但 DevPilot 的一键启动体验目前优先面向 Windows。

## 5 分钟开始使用

### 环境要求

- Windows 10 / 11
- Git
- Node.js `>=22.19 <27`
- npm

### 方式 A：让 AI 帮你一键安装（最适合新手）

把下面整段提示词复制给一个**能够操作你本机终端和文件**的 AI 编程助手，例如 Codex、Claude Code 或其他本地 Coding Agent：

```text
请帮我在这台 Windows 电脑上安装并验证 DevPilot：
https://github.com/1210350468/devpilot.git

目标：让我作为新手最终只需要双击“启动-DevPilot.cmd”即可使用。

请直接执行，不要只给教程。按下面顺序完成：

1. 检查 Git、Node.js、npm 是否可用。DevPilot 要求 Node.js >=22.19 且 <27。
2. 如果环境缺失，优先使用系统现有包管理器安全安装；不要删除或覆盖我已有的软件环境。如果需要管理员权限，明确告诉我原因。
3. 把仓库克隆到一个合适的新目录。若目标目录已存在，不要直接覆盖，先检查它是否已经是 DevPilot 仓库。
4. 在仓库中执行依赖安装、typecheck、build 和 test，修复由本机环境导致的可修复问题，直到项目通过验证。
5. 检查“启动-DevPilot.cmd”和“关闭-DevPilot.cmd”存在，并确认 PowerShell 启动脚本语法正常。
6. 不要把 API Key、Tunnel Runtime Key、OAuth Token、Cookie 或其他凭据写进 Git。`.devpilot-config/` 和 `.devpilot-runtime/` 必须保持为本地私有目录。
7. 第一次使用如果我没有 OpenAI Secure Tunnel 的 Tunnel ID 和 Runtime API Key，就推荐我在启动菜单里选择 Cloudflare Quick Tunnel，不要阻塞安装。
8. 如果我明确选择 OpenAI Secure MCP Tunnel，再指导我把 Tunnel ID / Runtime API Key 写入本地 `.devpilot-config/openai-tunnel.json`；不要在终端输出或聊天中回显完整 Runtime API Key。
9. 不要杀掉与 DevPilot 无关的进程，不要修改全局 Git 配置，不要执行 git clean / reset --hard。
10. 完成后实际启动一次 DevPilot，验证：
   - 本地 Control Center 可访问；
   - MCP 服务在线；
   - 所选 Tunnel 就绪；
   - 然后告诉我在 ChatGPT 中应该填哪个 MCP URL 或 Tunnel ID。
11. 最后给我一个非常简短的“以后怎么启动 / 怎么关闭 / 出问题看哪里”的说明。

如果仓库文档与我的机器实际情况冲突，以实际检测结果为准，并把差异说明清楚。
```

更完整版本见：[AI_INSTALL_PROMPT.md](AI_INSTALL_PROMPT.md)。

### 方式 B：手动安装

```powershell
git clone https://github.com/1210350468/devpilot.git
cd devpilot
npm install
npm run build
```

之后双击：

```text
启动-DevPilot.cmd
```

启动菜单：

```text
> Cloudflare Quick Tunnel
  OpenAI Secure MCP Tunnel
```

使用 **↑ / ↓** 选择，**Enter** 启动，**Esc** 取消。

首次启动时，如果 `node_modules` 不存在，启动器也会自动执行依赖安装；如果 `dist` 不存在，则会自动构建。

## 两种连接模式

### Cloudflare Quick Tunnel

适合第一次使用和希望快速验证链路的用户。

启动器会：

- 启动 DevPilot / DevSpace MCP：`127.0.0.1:7681`
- 启动本地 Supervisor：`127.0.0.1:7680`
- 使用 OAuth 模式
- 自动下载或复用 `cloudflared`
- 创建临时 `https://*.trycloudflare.com/mcp`
- 将公网 MCP URL 复制到剪贴板

然后把启动器给出的完整 `/mcp` 地址添加到支持 Remote MCP 的客户端，并按提示完成 OAuth。

> Cloudflare Quick Tunnel 地址在重新启动后可能变化。若你的 OAuth 客户端通过额外的完整 resource URL 别名访问同一 MCP，可在 Control Center 的“OAuth Resource 别名”中显式加入；普通 Quick Tunnel 用户无需配置。

### OpenAI Secure MCP Tunnel

适合已经创建 OpenAI Tunnel、希望本地 MCP 只监听 loopback 的用户。

本地配置文件：

```text
.devpilot-config/openai-tunnel.json
```

示例：

```json
{
  "tunnelId": "tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "runtimeApiKey": "YOUR_RUNTIME_API_KEY",
  "controlPlaneProxy": "http://127.0.0.1:YOUR_PROXY_PORT"
}
```

`controlPlaneProxy` 可省略。该配置目录已被 `.gitignore` 排除。

启动器会：

- 使用 `authMode=secure-tunnel`
- 下载或复用 OpenAI 官方 `tunnel-client`
- 将本地 MCP 保持在 `127.0.0.1:7681/mcp`
- 检查 `127.0.0.1:7683/readyz`
- 支持 OpenAI control-plane 专用 HTTP 代理
- 检测常见的同 Tunnel ID 多客户端冲突

一个 Tunnel ID 不应同时被两个本地 `tunnel-client` 消费，否则 MCP session 和工具集合可能被拆到不同进程。

## MCP 协议兼容

DevPilot 在保持现有 8-tool surface（`open_workspace/read/write/edit/grep/glob/ls/bash`）不变的前提下，同时兼容：

- MCP `2026-07-28` modern per-request/stateless 路径；
- MCP `2025-06-18` 等既有 Streamable HTTP session 客户端。

modern 请求由 MCP 2.x handler 处理，legacy 请求仍走原有 session registry。两条路径复用同一套工具注册逻辑，因此升级协议层不会把 DevPilot 的正式工具面替换成上游 Codex-style surface，也不会改变 OpenAI Secure MCP Tunnel 的 loopback-only 约束。

回归测试会同时验证 modern discovery/tools/call、legacy initialize/session、Secure Tunnel discovery 404 以及原有 workspace conversation reuse。

## 本地 Control Center

启动后访问：

```text
http://127.0.0.1:7681/devpilot/
```

目前主要提供：

- 服务 / Tunnel 状态
- allowed roots 配置
- MCP / 认证 / tool mode / widgets 设置
- ChatGPT 请求观察器
- 按 ChatGPT 对话区分请求
- 工具名、参数摘要、HTTP 状态与耗时

第一次启动、且没有已有 DevPilot / DevSpace 配置时，allowed roots 默认只包含 **DevPilot 仓库自身**。请在 Control Center 中添加你确实希望 ChatGPT 能访问的项目目录。

## 端口

| 用途 | 默认地址 |
| --- | --- |
| DevPilot / MCP | `127.0.0.1:7681` |
| Supervisor | `127.0.0.1:7680` |
| OpenAI Tunnel health/UI | `127.0.0.1:7683` |
| Control Center | `http://127.0.0.1:7681/devpilot/` |

## 关闭

双击：

```text
关闭-DevPilot.cmd
```

关闭脚本会优先读取 `.devpilot-runtime/runtime.json` 中记录的实际端口和 Supervisor PID，只针对当前 DevPilot 管理的服务，不应主动结束无关进程。

## 安全说明

DevPilot 能让远程 MCP 客户端在你批准的本地项目中读取、编辑和执行命令，因此它拥有真实的本机开发权限。

- 只把可信目录加入 `allowedRoots`。
- Shell 命令以当前 Windows 用户权限运行，不是完整沙箱。
- 不要公开 `.devpilot-config/`、`.devpilot-runtime/`、Runtime API Key 或 OAuth Token。
- `widgets=off` 只能关闭 DevSpace 自己提供的 MCP Widget/App UI，**不能强制隐藏 ChatGPT 客户端原生的工具调用提示**。

默认 `.gitignore` 已排除：

```text
.devpilot-config/
.devpilot-runtime/
DevPilot-connection.txt
当前公网MCP地址.txt
tools/cloudflared.exe
tools/tunnel-client.exe
*.log
```

## 开发与验证

```powershell
npm install
npm run typecheck
npm run build
npm test
```

详细设计与故障说明：

- [DevPilot 技术说明](docs/devpilot.md)
- [中文使用说明](使用说明-中文.md)
- [AI 安装提示词](AI_INSTALL_PROMPT.md)

## 与上游 DevSpace 的关系

DevPilot 基于 [Waishnav/devspace](https://github.com/Waishnav/devspace) 修改，并保留原项目的 MIT License 与核心执行模型。

DevPilot 的目标不是替代 DevSpace，而是在其上增加更适合 ChatGPT 本地开发工作流的：

- 中文本地控制中心
- 请求 / 对话观察器
- Windows 一键启动与 Tunnel 管理
- OpenAI Secure MCP Tunnel 适配

感谢 DevSpace 原作者及其贡献者。

## License

MIT。见 [LICENSE](LICENSE)。
