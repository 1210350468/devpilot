# DevPilot Upstream-First Overlay

This test build intentionally follows `Waishnav/devspace` upstream as the core architecture and keeps DevPilot as a thin overlay.

## Core ownership

Upstream owns MCP tool surfaces, workspaces, process sessions, worktrees, subagents, skills, change review, and model-facing schemas.

DevPilot adds only:

- local Control Center with overview, ChatGPT request observer, conversation grouping, editable settings, and runtime controls;
- OpenAI Secure MCP Tunnel lifecycle;
- Windows one-click launch/stop scripts;
- high-fidelity image reads;
- oversized-image overview plus 2x2 detail tiles;
- a small Windows provider-availability correction for OpenCode.

## Test ports

- Control Center: `http://127.0.0.1:47680/devpilot/`
- MCP: `http://127.0.0.1:47681/mcp`
- tunnel health: `http://127.0.0.1:47683/readyz`

Production remains on `7680 / 7681 / 7683`.
The older candidate supervisor may remain on `37680 / 37681`, but its tunnel is stopped while this build owns the shared candidate Tunnel ID.

## ChatGPT tool surface

The test build uses upstream `codex` mode:

- `open_workspace`
- `read`
- `show_changes`
- `apply_patch`
- `exec_command`
- `write_stdin`

Do not expect the old legacy `write/edit/grep/glob/ls/bash` surface in a refreshed ChatGPT connector.

## ChatGPT connector refresh

Existing conversations may cache the old candidate tool schema. After switching the server from the legacy eight-tool surface to upstream Codex mode, refresh/reconnect the `devpilot_candidate` connector or use a new chat. If the old schema persists, create a fresh test connector (for example `devpilot_upstream`) pointing to the same candidate Tunnel ID. A fresh discovery should expose the six tools above.

## Windows one-click behavior

`启动-DevPilot-Upstream.cmd` runs `scripts/start-devpilot.ps1` and:

1. loads the existing candidate OpenAI tunnel credentials locally without printing them;
2. prepares a separate local DevSpace config;
3. uses `E:\coding` and `E:\minecraft` as allowed roots;
4. selects upstream `codex` tool mode;
5. starts MCP, tunnel, and Control Center;
6. waits for READY;
7. opens the Control Center in the default browser.

The Control Center restores the original DevPilot information architecture instead of using the temporary simplified dashboard:

- **总览** shows MCP/Tunnel state, the real upstream tool surface, providers, lifecycle events, and recent MCP requests;
- **请求观察器** groups requests by `openai/session` and shows MCP method, tool name, status, latency, session metadata, and parameter previews;
- **设置** writes directly to upstream DevSpace `config.jsonc` for allowed roots, `codex/claude` tool surface, MCP App UI, artifacts, skills, subagents, and logging. Saved runtime-affecting settings are applied after restart.

The removed legacy `minimal/full/widgets` choices are not emulated because they no longer match upstream's real configuration contract.

`关闭-DevPilot-Upstream.cmd` stops the tunnel, MCP server, and supervisor.

## Verified test state

- typecheck: PASS
- build: PASS
- `git diff --check`: PASS
- upstream Codex/Claude surface tests on the first overlay prototype: PASS
- secure-tunnel OAuth bypass test: PASS
- image payload >50KB test: PASS
- oversized image overview + four tiles test: PASS
- restored Control Center page and JS asset: HTTP 200
- request observer unit tests: PASS
- request observer live API: PASS
- settings live API: PASS (`E:\\coding` and `E:\\minecraft` roots, `codex` surface)
- live MCP: online
- live OpenAI tunnel: READY
- OpenCode availability: correctly reports unavailable when the executable is absent
