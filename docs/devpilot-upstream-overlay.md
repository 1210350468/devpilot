# DevPilot Upstream-First Overlay

DevPilot follows `Waishnav/devspace` upstream as the core architecture and keeps the DevPilot-specific product layer intentionally thin.

## Core ownership

Upstream owns MCP tool surfaces, workspaces, process sessions, worktrees, subagents, skills, change review, artifacts, and model-facing schemas.

DevPilot adds only:

- local Control Center with overview, ChatGPT request observer, conversation grouping, editable settings, and runtime controls;
- OpenAI Secure MCP Tunnel lifecycle;
- Windows one-click launch/stop scripts;
- high-fidelity image reads;
- oversized-image overview plus 2x2 detail tiles;
- a small Windows provider-availability correction for OpenCode.

The design goal is to keep upstream synchronization cheap: prefer a small overlay over reimplementing or forking upstream MCP mechanics.

## Default local ports

- Control Center: `http://127.0.0.1:47680/devpilot/`
- MCP: `http://127.0.0.1:47681/mcp`
- tunnel health: `http://127.0.0.1:47683/readyz`

These ports are local defaults and can be overridden by the launcher parameters.

## ChatGPT tool surface

The default tool mode is upstream `codex`:

- `open_workspace`
- `read`
- `show_changes`
- `apply_patch`
- `exec_command`
- `write_stdin`

The old DevPilot eight-tool surface (`open_workspace/read/write/edit/grep/glob/ls/bash`) is no longer the default architecture.

The upstream `claude` surface remains available through configuration.

## ChatGPT connector refresh

ChatGPT can cache a connector's previous tool schema. When upgrading from a legacy DevPilot connector to the upstream-first surface, use a new connector name or reconnect the existing connector so discovery runs again.

A refreshed connector should expose the six Codex tools above. If a host reports an old tool name such as `bash` against a Codex surface, verify host-side connector discovery before restarting DevPilot.

## Windows one-click behavior

`启动-DevPilot.cmd` runs `scripts/start-devpilot.ps1` and:

1. prepares local ignored DevPilot config/runtime directories;
2. defaults the first allowed root to the repository's parent directory on a fresh install;
3. selects upstream `codex` tool mode;
4. loads OpenAI Secure MCP Tunnel credentials from `.devpilot-config/openai-tunnel.json` or `DEVPILOT_OPENAI_TUNNEL_CONFIG`;
5. finds `tunnel-client` from `DEVPILOT_OPENAI_TUNNEL_CLIENT`, `tools/tunnel-client.exe`, or `PATH`;
6. starts MCP, tunnel, and Control Center;
7. waits for READY;
8. opens the Control Center in the default browser.

The launcher does not contain machine-specific absolute paths and does not stop unrelated older DevPilot processes.

The Control Center provides:

- **总览** for MCP/Tunnel state, real upstream tool surface, providers, lifecycle events, and recent MCP requests;
- **请求观察器** grouped by `openai/session`, including MCP method, tool name, status, latency, session metadata, and parameter previews;
- **设置** backed by upstream DevSpace `config.jsonc`, including allowed roots, `codex/claude` tool surface, MCP App UI, artifacts, skills, subagents, and logging.

`关闭-DevPilot.cmd` stops the DevPilot-managed tunnel, MCP server, and supervisor recorded by the local runtime state.

## High-fidelity image reads

DevPilot wraps the upstream `read` path without changing the model-facing tool name:

- images within the inline payload budget are returned at original resolution where possible;
- oversized images receive the normal overview plus a 2x2 set of bounded JPEG detail tiles;
- tile labels include their source pixel region;
- tile failure degrades safely to the upstream overview.

This is intended for large screenshots, UI captures, diagrams, and game/building screenshots where downscaling destroys small details.

## Verified release state

Release-candidate verification on Windows completed with:

- `pnpm install --frozen-lockfile`: PASS
- `pnpm audit --prod`: **0 known vulnerabilities**
- `pnpm typecheck`: PASS
- full `pnpm test`: **139 total / 133 pass / 0 fail / 6 platform-or-optional skips**
- `pnpm build`: PASS
- `git diff --check`: PASS
- `npm pack --dry-run`: PASS
- upstream Codex/Claude tool-surface tests: PASS
- secure-tunnel OAuth-bypass regression: PASS
- high-fidelity image regressions: PASS
- Control Center page and assets: HTTP 200
- request observer tests and live API: PASS
- live MCP: online
- live OpenAI Secure MCP Tunnel: READY
- OpenCode availability: correctly reports unavailable when the executable is absent

## Upstream policy

Before a release, fetch `upstream/main`, review divergence, and prefer rebasing/rebuilding the thin overlay on the current upstream baseline instead of accumulating compatibility patches.

Upstream: <https://github.com/Waishnav/devspace>
