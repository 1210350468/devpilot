# DevPilot AI 一键安装提示词

这份提示词面向**不熟悉 Git / Node.js / MCP / Tunnel 的新手**。把整段复制给一个能够操作你本机终端和文件的 AI 编程助手，让它直接完成安装、验证和第一次启动。

## 推荐提示词

```text
你现在是我的 Windows 本机安装助手。请直接帮我安装并验证 DevPilot，不要只给教程。

仓库：
https://github.com/1210350468/devpilot.git

最终目标：
让我以后只需要双击仓库根目录里的“启动-DevPilot.cmd”即可使用 DevPilot；关闭时双击“关闭-DevPilot.cmd”。

请按下面规则执行：

【安全边界】
1. 不要删除、覆盖或重置我已有的项目与配置。
2. 不要执行 git clean、git reset --hard、格式化磁盘、批量删除目录等危险操作。
3. 不要修改全局 Git 用户名、邮箱或其他与本项目无关的全局设置。
4. 不要结束与 DevPilot 无关的进程；如果端口被占用，先识别占用者并说明。
5. 不要把 API Key、OpenAI Tunnel Runtime API Key、OAuth Token、Cookie、密码等秘密写入 Git、README、日志或聊天输出。
6. 如果需要保存 OpenAI Tunnel Runtime API Key，只能保存在仓库本地且已被 Git 忽略的 `.devpilot-config/openai-tunnel.json` 中，并且不要回显完整 Key。

【环境检查】
7. 检查 Windows 版本、PowerShell、Git、Node.js、npm。
8. DevPilot 要求 Node.js >=22.19 且 <27。若 Node 不满足，优先使用系统已有包管理器安全安装一个符合要求的版本。
9. 如果安装软件需要管理员权限，明确告诉我原因；不要通过关闭安全机制来绕过权限问题。

【克隆与安装】
10. 选择一个合适的新目录克隆仓库。如果当前目录已经存在 DevPilot，请先确认 Git remote 和仓库内容，不要覆盖。
11. 执行：
    - npm install
    - npm run typecheck
    - npm run build
    - npm test
12. 如果测试失败，先判断是代码问题还是本机环境问题。能安全修复的就修复；不能确认的不要胡乱改系统。
13. 确认根目录只需要主要使用：
    - 启动-DevPilot.cmd
    - 关闭-DevPilot.cmd
14. 检查 `scripts/start-devpilot.ps1` 和 `scripts/stop-devpilot.ps1` 的 PowerShell 语法。

【第一次启动】
15. 实际启动一次 DevPilot。
16. 如果我没有 OpenAI Secure MCP Tunnel 的 Tunnel ID 和 Runtime API Key，默认建议我选择：
    Cloudflare Quick Tunnel
17. Cloudflare 模式启动后，确认：
    - MCP 服务在线；
    - 本地 Control Center 可以访问；
    - 获得一个 `https://*.trycloudflare.com/mcp` 地址；
    - 告诉我在 ChatGPT 的 Remote MCP / 自定义 App 中应该使用这个地址。
18. 如果我明确选择 OpenAI Secure MCP Tunnel，则先确认我有：
    - Tunnel ID
    - Runtime API Key
19. 将 OpenAI Tunnel 配置保存在：
    `.devpilot-config/openai-tunnel.json`
    格式类似：
    {
      "tunnelId": "tunnel_xxx",
      "runtimeApiKey": "<secret>",
      "controlPlaneProxy": "http://127.0.0.1:<optional-port>"
    }
20. 如果本地网络访问 OpenAI control plane 需要代理，检查现有本地代理端口后再填写，不要凭空写死端口。
21. OpenAI 模式启动后验证：
    - `http://127.0.0.1:7681/mcp` 本地 MCP 在线；
    - `http://127.0.0.1:7683/readyz` 返回 ready；
    - Tunnel ID 没有被另一个 tunnel-client 同时消费。

【权限与项目目录】
22. 第一次启动时，allowed roots 应保持保守。不要擅自把整个系统盘加入允许目录。
23. 告诉我可以在本地 Control Center 中加入我真正希望 ChatGPT 操作的代码目录。

【最终验收】
24. 最后请给我一份简短验收结果，只包括：
    - DevPilot 安装目录
    - Node / npm 版本
    - typecheck / build / test 是否通过
    - 当前选择的 Tunnel 模式
    - Control Center 地址
    - ChatGPT 应该使用的 MCP URL 或 Tunnel ID
    - 以后如何启动
    - 如何关闭
    - 日志在哪里看
25. 如果某一步没有真实验证，不要写“已完成”；明确写“未验证”以及原因。

请现在开始直接执行。
```

## 给已经安装过旧版 DevSpace 的用户

如果你的机器上以前已经运行过 DevSpace，请再追加下面这段：

```text
我的电脑以前可能安装或运行过 DevSpace。请优先复用已有的 allowedRoots / owner token，但不要覆盖旧 DevSpace 配置；DevPilot 应使用自己的 `.devpilot-config/` 与 `.devpilot-runtime/`。如果发现旧 DevSpace 正在占用端口，请先识别，不要直接杀进程。
```

## 给 OpenAI Secure Tunnel 用户

如果你已经有 OpenAI Tunnel，可以追加：

```text
我希望使用 OpenAI Secure MCP Tunnel。请检查本机是否已经有其他 tunnel-client 占用同一个 Tunnel ID，尤其是 codex-chatgpt-web。一个 Tunnel ID 只给一个本地 tunnel-client 使用。如果发生冲突，停止并告诉我应该新建或改用哪个独立 Tunnel，而不是让两个进程抢同一个 Tunnel。
```
