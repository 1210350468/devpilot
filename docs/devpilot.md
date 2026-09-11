# DevPilot

DevPilot 是这个 DevSpace fork 的轻量增强层，不是新的 Agent Harness，也不是任务调度平台。

它只做三件事：

1. 给 DevSpace 提供本地中文控制/配置页面。
2. 观察 ChatGPT → DevSpace 的 MCP 请求与工具调用，并按 `openai/session` 隔离不同 ChatGPT 对话。
3. 通过关闭 DevSpace widgets、集中展示详细调用过程来减少 ChatGPT 页面里的额外 UI 噪声。

## 两种连接结构

### Cloudflare Quick Tunnel（当前默认稳定入口）

```text
ChatGPT Remote MCP
   │
   ▼
https://*.trycloudflare.com/mcp
   │
cloudflared
   │
   ▼
DevSpace 127.0.0.1:7681
   ├─ /mcp
   ├─ /devpilot/
   ├─ /devpilot/api/requests
   └─ /devpilot/api/conversations

DevPilot supervisor 127.0.0.1:7680
```

该模式使用 DevSpace 原有 OAuth flow，启动器自动设置 `authMode=oauth`。

### OpenAI Secure MCP Tunnel（独立可选入口）

```text
ChatGPT
   │
   │ OpenAI Secure MCP Tunnel
   ▼
OpenAI Tunnel Service
   ▲
   │ outbound HTTPS
   │
tunnel-client
   │
   ▼
DevSpace 127.0.0.1:7681/mcp

DevPilot supervisor 127.0.0.1:7680

tunnel-client health 127.0.0.1:7683
   ├─ /healthz
   ├─ /readyz
   └─ /ui
```

该模式使用 `authMode=secure-tunnel`，本地 MCP 强制保持 loopback-only。

## Windows 启动入口

项目位置就是你克隆 DevPilot 的仓库目录，例如：

```text
C:\Users\<你>\DevPilot
```

正式入口只有：

```text
启动-DevPilot.cmd
```

双击后使用 **↑ / ↓** 在 `Cloudflare Quick Tunnel` 与 `OpenAI Secure MCP Tunnel` 之间选择，按 **Enter** 启动，按 **Esc** 取消。菜单最终调用同一个 `scripts/start-devpilot.ps1`，并自动切换对应认证方式。脚本仍支持显式 `-TunnelProvider cloudflare-quick|openai-secure`，供自动化场景跳过交互菜单。

关闭统一使用：

```text
关闭-DevPilot.cmd
```

它只关闭 DevPilot Supervisor 当前管理的服务，不主动结束旧的 7676 DevSpace，也不结束独立运行的 `codex-chatgpt-web` tunnel-client。

## OpenAI Tunnel 配置

配置文件：

```text
<DevPilot仓库>\.devpilot-config\openai-tunnel.json
```

包含：

```text
tunnelId
runtimeApiKey
controlPlaneProxy（可选）
```

该目录被 `.gitignore` 排除。Runtime API Key 不应出现在日志、命令行或提交记录中。

OpenAI control-plane 代理示例：

```json
{
  "controlPlaneProxy": "http://127.0.0.1:YOUR_PROXY_PORT"
}
```

启动器会检查配置的本地代理是否正在监听；无效时尝试常见本地端口。最终代理以 `CONTROL_PLANE_HTTP_PROXY` 传给官方 `tunnel-client`，只用于 OpenAI control-plane HTTP(S) 流量；本地 MCP 仍直接访问 `127.0.0.1:7681`。

Supervisor 同时支持：

```text
DEVPILOT_OPENAI_CONTROL_PLANE_PROXY
CONTROL_PLANE_HTTP_PROXY
```

## OAuth Protected Resource Metadata

官方 `tunnel-client` 即使连接的是无 OAuth MCP，也会探测 RFC 9728 Protected Resource Metadata：

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-protected-resource
```

`secure-tunnel` 模式下 DevPilot 不广告 OAuth metadata，因此这两个路径现在明确返回**空 404**。这样 `tunnel-client` 会把它识别为“OAuth metadata not advertised”，而不会再尝试把 Express 默认 HTML 404 解码成 JSON。

Cloudflare OAuth 模式仍由 MCP SDK 的 `mcpAuthRouter` 提供标准 OAuth metadata。

## Tunnel ID 独占约束

一个 Tunnel ID 只能对应一个实际运行的本地 `tunnel-client` 消费者。

如果两个客户端同时 poll 同一个 Tunnel ID，请求可能被不同进程取走，造成：

- MCP session 状态被拆分
- 工具集合来自错误的后端
- 同一个 ChatGPT App 看起来像“串到了另一套 MCP”

启动器会检查正在运行的 `codex-chatgpt-web` tunnel-client 及其 profile；若它已经占用了 DevPilot 配置的 Tunnel ID，OpenAI 启动会直接失败并要求使用独立 Tunnel ID。

## MCP 双协议兼容

DevPilot 的协议层采用兼容式升级，而不是直接替换现有执行层：

```text
modern MCP 2026-07-28
        │
        ├─ MCP 2.x per-request handler
        │
        └──────────────┐
                       ▼
             DevPilot 现有工具注册面
                       ▲
        ┌──────────────┘
        │
legacy Streamable HTTP session
2025-06-18 等既有客户端
```

关键约束：

- 正式工具面仍是 `open_workspace/read/write/edit/grep/glob/ls/bash`；
- modern 与 legacy 两条路径复用同一套工具定义和 handler；
- modern 路径不依赖旧 `mcp-session-id`；legacy 路径继续保留现有 session registry；
- `secure-tunnel` 的 loopback-only、本地空 OAuth discovery 404、Request Inspector 和 `openai/session` 对话隔离保持不变；
- 不因为同步上游协议能力就引入第二套 Orchestrator 或直接切换到 Codex-style tool surface。

验收覆盖 modern `server/discover`、`tools/list`、真实 `tools/call`、legacy `initialize` + session ID，以及完整 `npm test/typecheck/build`。

### 上游同步稳定性约束

后续同步继续采用能力级吸收，而不是整批 merge：

- MCP `serverInfo.version` 从 `package.json` 动态读取，避免客户端看到过期的硬编码版本；
- WorkspaceRegistry 的内存上下文缓存限制为最近使用的 32 个 workspace，超出后按 LRU 驱逐，持久化 session 仍可按需恢复；
- 上游某些提交把 cache 优化与 Skill 读取权限放宽绑在一起，DevPilot 只吸收 cache 部分，继续要求先加载已广告的 `SKILL.md` 后才能访问对应 Skill 目录；
- 与现有 8-tool surface、Secure Tunnel、Request Inspector 无直接收益的 process/tool-surface 重构继续保持 HOLD。

## 请求观察器与对话隔离

请求观察器记录最近的 MCP/HTTP 请求，包括：

- ChatGPT `openai/session`
- MCP session
- 请求时间
- HTTP method / path
- MCP method
- `tools/call` 工具名
- 参数摘要
- HTTP 状态
- 耗时
- User-Agent
- request id

UI 按“ChatGPT 对话 → 对话内请求 → 请求详情”三栏展示。同一 MCP session 后续请求可继承已经识别的 `openai/session`。

记录目前保存在内存中，DevSpace 重启后清空。

## 关于 ChatGPT 工具卡片

`widgets=off` 只能关闭 DevSpace 自己返回的 MCP Widget/App UI。

ChatGPT 网页自身渲染的原生工具调用状态属于客户端行为，MCP 服务端不能强制隐藏。DevPilot 的目标是减少 DevSpace 自己的额外 UI，并把详细请求集中到本地观察器。
