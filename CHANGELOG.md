# Changelog

## 2026-09-15 — Upstream-first DevPilot

DevPilot was rebuilt on top of the current `Waishnav/devspace` upstream architecture instead of continuing the legacy eight-tool fork.

### Added

- Full local Control Center with overview, runtime controls, request observer, conversation grouping, and editable settings.
- OpenAI Secure MCP Tunnel lifecycle integration and READY health reporting.
- Windows one-click start/stop launchers.
- High-fidelity image reads with original-resolution preservation when possible.
- Oversized-image overview plus 2×2 bounded detail tiles.
- Request diagnostics for MCP discovery and tool calls.

### Changed

- Default ChatGPT/Codex tool surface now follows upstream: `open_workspace`, `read`, `show_changes`, `apply_patch`, `exec_command`, `write_stdin`.
- Long-running commands use upstream process sessions through `exec_command` / `write_stdin`.
- DevPilot is now maintained as a thin overlay over upstream DevSpace rather than a parallel MCP implementation.
- One-click startup no longer contains machine-specific absolute paths.
- GitHub source distribution is intentionally private-from-npm (`package.json` keeps the upstream internal package name for compatibility but sets `private: true`).

### Fixed

- OpenCode availability no longer reports a false positive when its executable is missing.
- Large image reads no longer fall into the old text-size truncation behavior.
- Control Center settings reload on restart instead of reusing stale in-memory configuration.
- Production dependency audit was reduced to 0 known vulnerabilities through patched transitive dependency resolutions.

### Verification

- `pnpm install --frozen-lockfile`: PASS
- `pnpm audit --prod`: 0 known vulnerabilities
- `pnpm typecheck`: PASS
- `pnpm test`: 139 total / 133 pass / 0 fail / 6 platform-or-optional skips
- `pnpm build`: PASS
- `git diff --check`: PASS
- `npm pack --dry-run`: PASS
