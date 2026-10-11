# DevPilot Windows 发布、首次配置与安全更新

## 使用者：从 GitHub Releases 安装

1. 进入 <https://github.com/1210350468/devpilot/releases>，下载带 `DevPilot-windows-x64-vX.Y.Z.zip` 和同名 `.sha256` 文件的发行版本。
2. 使用 `Get-FileHash .\DevPilot-windows-x64-vX.Y.Z.zip -Algorithm SHA256` 核对压缩包 SHA256。发行工作流会同时生成可独立下载的 SHA256 清单。
3. 解压 ZIP，里面有 `DevPilot` 目录。建议放在用户有写入权限的短路径，例如 `D:\Apps\DevPilot`，不要直接解压到系统盘根目录。如果 Windows 资源管理器提示路径过长，可在 PowerShell 中运行 `tar -xf DevPilot-windows-x64-vX.Y.Z.zip`。
4. 双击 `首次配置-DevPilot.cmd`，选择允许访问的具体项目目录，以及 Cloudflare Quick Tunnel（首次推荐）或用户自己的 OpenAI Secure MCP Tunnel。
5. 首次运行需要用户自行完成 ChatGPT MCP/App 授权。必须确认 Control Center 和实际 Tunnel READY；不能仅凭启动器窗口或端口监听判断成功。
6. 后续用 `启动-DevPilot.cmd` 启动、`关闭-DevPilot.cmd` 退出。便携包已自带 Windows Node.js runtime 与生产依赖，不需要用户另装 Node/pnpm。

**受限功能说明：** 便携发行版暂不捆绑 Pi Agent 的 `@anthropic-ai/sandbox-runtime`，因为其 `node-forge` 间接依赖仍存在公开且未修复的签名验证漏洞。使用 Pi 的受限写入模式时会**明确拒绝执行**，不会自动降级成无限制运行。Codex/Claude 和 DevPilot 的普通 MCP、Goal、Control Center、工作区等核心功能不依赖该沙箱运行时。需要 Pi 沙箱的开发者应使用源码开发环境，并自行评估对应上游安全风险。

## 更新与回滚

- Control Center 的“版本与更新”使用 GitHub Releases 公开 API，只在用户点击时检查，不会自动安装。
- `更新-DevPilot.cmd` 从 **官方 GitHub Release** 获取 ZIP 和 `.sha256`，验证内容哈希、版本及必要文件。
- **必须先停止**当前 DevPilot；检测到已有活跃 Supervisor 或 Control Center 会拒绝覆盖。没有静默杀进程或跨实例抢占。
- 更新器将旧目录原样移动到带时间戳的 `.backup-*` 目录，再把验证后的新版本放在原位置；私有的 `.devpilot-config`、`.devpilot-runtime`（包含 Goal 状态、工作区和任务历史）都会复制到新目录。旧 `runtime.json` 是过期 PID 快照，会移除。
- 更新出错时尽可能自动移回旧目录。用户还可以保留完整备份手动回滚。**不要随意删除备份**，确认新版本运行正常并有独立备份后才考虑清理。
- 为避免破坏密钥和研究进度，**源码安装**不支持 ZIP 原地覆盖，需使用自己的 Git 分支进行 `git pull --ff-only` 后重新构建。
- 更新工具不能证明 OpenAI ChatGPT 端已经刷新了 MCP schema；新工具参数不可见时可能需要刷新连接或新开 Chat。

## 维护者：构建和发布

专用 GitHub Actions 工作流：`.github/workflows/windows-portable.yml`。

1. 在 GitHub **Actions → Windows portable release → Run workflow** 选择经过 review/CI 的正确分支。
2. 在 `candidate/*` 分支只允许输入 `vX.Y.Z-beta.N` 或 `vX.Y.Z-rc.N`，发布 GitHub 预发行；正式 `main` 只允许 `vX.Y.Z`。
3. 工作流在 Windows Runner 上执行 `pnpm install`、TypeScript、回归测试和构建；源代码用 `pnpm install --prod` 打包原生 Windows 依赖，加入 Node 22 runtime，执行 `better-sqlite3` 冒烟测试，输出可解压的 ZIP 和同名 SHA256。
   Pi 原生受限沙箱属于开发依赖，不进入可分发的生产依赖树。打包阶段会断言该包不存在，并验证普通运行模块在缺少该沙箱时仍可导入。
4. 工作流先上传 artifacts，再创建 GitHub Release；预发行不会默认替换 GitHub Releases 的稳定版本。
   如果生产依赖安全审计失败，则仍可生成 Actions artifact 供维护者验证打包，但**禁止创建公开 Release**，且工作流标记失败。修复依赖或经项目安全审查后再重新触发正式发布。
5. **必须检查** Release 的 GitHub Actions 日志、Windows 原生依赖冒烟测试、实际 ZIP 内容，以及独立 Windows 测试机上首次配置、启动、更新和回滚流程，才能标记为稳定版。

早期上游 `.github/workflows/release.yml` 是 npm 发布流程，**不是** DevPilot Windows ZIP 的发布入口。不要用它发布本项目的便携安装包。

## 已知限制

首次配置向导目前是 PowerShell 文本式交互，不是 MSI/WiX 图形安装程序。便携 ZIP 也是免 Node 安装环境，不是已经签名的 EXE 安装器；Windows SmartScreen 对无签名脚本/执行文件可能提示风险。不要绕过系统安全策略安装来历不明的文件。

从便携版迁移到源码版或跨主版本升级可能需要额外的数据迁移。真正执行前应保留现有文件备份并对比 release notes。
