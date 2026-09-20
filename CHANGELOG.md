# Changelog

## Unreleased — Persistent Workspace Channel v2

- Start the GPT-native Persistent Goal runtime as the next PWC slice. A new top-level `goal` MCP tool persists objective, acceptance criteria, evidence, compact resume state, cross-conversation attachments, and an append-only event journal in the existing DevPilot SQLite database; the ChatGPT host remains the reasoning agent and no local model is required.
- Add SQLite migration 10 (`persistent-goals`) with goal, criterion, conversation-binding, and event tables linked to the existing workspace-session lifecycle.
- Make Goal completion fail closed: `goal finish` returns `GOAL_NOT_COMPLETE` while any required criterion is not verified as passed, so a browser continuation layer can rely on durable Goal state instead of assistant prose.
- Validate that a Goal created in one OpenAI conversation can attach to a second conversation and continue against the same persisted workspace session without copying the old chat transcript.

- Cache conversation-scoped workspace bootstrap context so repeated `open_workspace` calls do not recursively rediscover AGENTS / CLAUDE files unless `refresh_context=true` is requested.
- Add Codex `workspace_turn` batching for up to eight ordered reads, short commands, or process polls in one MCP round trip.
- Mirror each batched step's model-readable output into structured content so ChatGPT hosts receive the actual file or command results.
- Keep `apply_patch` and `show_changes` separate so mutation and review boundaries remain explicit.
- Preserve full nested instruction discovery while parallelizing directory traversal to reduce large-workspace cold-open latency.
- Keep detailed `workspace_turn` output in structured step results only, avoiding a second copy of large reads in ordinary text content.
- Validate through a separate OpenAI Secure MCP Tunnel: warm GTNH reopen reached 13 ms, restart recovery 3718 ms after scan optimization, and four reads plus one command completed in one 264 ms workspace turn.
- Develop and validate the feature in an isolated worktree before any promotion to `main`.
- Add conversation-workspace task checkpoints with durable `active / blocked / done` state, concise summary/next-step recovery, and SQLite migration coverage.
- Add bounded Git workspace deltas to `workspace_turn`, returning changed paths and aggregate line counts instead of reinjecting a full patch.
- Return an optional compact `resume` checkpoint from repeated `open_workspace` calls so long-running work can continue after process restart without rereading broad project context.
- Bound aggregate `workspace_turn` step text with a fair configurable context budget (32k characters by default, 4k–96k supported) and explicit per-step truncation metadata.
- Fix the Windows stop launcher to terminate the current `supervisorPid` written by runtime state while retaining the legacy `pid` fallback.
- Preserve legacy DevPilot production settings during upstream-first migration, including the old `toolMode`, `authMode`, and `widgets` fields, while keeping unknown-key migration fail-closed.
- Keep existing runtime ports during upgrade when the launcher is started without explicit port overrides, so an installed `7680 / 7681 / 7683` deployment does not silently move to new defaults.
- Prevent first-run launcher defaults from overwriting an existing legacy `config.json`; the runtime now migrates it atomically and retains `config.json.v1.0.bak` for rollback.
- Localize legacy deployments that did not specify `stateDir` / `worktreeRoot` into the DevPilot project's `.devpilot-runtime` tree before server startup, avoiding accidental reuse of an unrelated global DevSpace SQLite database.
- Run the legacy migration preflight through Node stdin instead of PowerShell `--eval`, avoiding Windows PowerShell 5.1 quote corruption.
- Validate the production-like promotion path in an isolated detached worktree: legacy config copy → first install/build → atomic config migration → SQLite migrations 1–9 → local MCP + Cloudflare Quick Tunnel READY, with the real production `768x` processes unchanged.
- Validate rollback independently by restoring `config.json.v1.0.bak` as legacy `config.json` and confirming the production baseline code can read the original six allowed roots and legacy runtime modes without understanding the new SQLite state.
- Increase the default interactive process grace window from 250 ms to 500 ms after real Windows stress testing showed that cold child-process startup could otherwise return a nearly-finished session as still running and force an avoidable follow-up poll; completed processes still return immediately.

## 2026-09-15 — Upstream-first DevPilot

DevPilot was rebuilt on top of the current `Waishnav/devspace` upstream architecture instead of continuing the legacy eight-tool fork.

### Added

- Full local Control Center with overview, runtime controls, request observer, conversation grouping, and editable settings.
- Dual startup modes: Cloudflare Quick Tunnel and OpenAI Secure MCP Tunnel.
- OpenAI Secure MCP Tunnel lifecycle integration and READY health reporting.
- Windows one-click start/stop launchers with an interactive mode selector and persistent success/error output.
- High-fidelity image reads with original-resolution preservation when possible.
- Oversized-image overview plus 2×2 bounded detail tiles.
- Request diagnostics for MCP discovery and tool calls.

### Changed

- Default ChatGPT/Codex tool surface now follows upstream: `open_workspace`, `read`, `show_changes`, `apply_patch`, `exec_command`, `write_stdin`.
- Long-running commands use upstream process sessions through `exec_command` / `write_stdin`.
- DevPilot is now maintained as a thin overlay over upstream DevSpace rather than a parallel MCP implementation.
- One-click startup no longer contains machine-specific absolute paths.
- The launcher now waits for real MCP + Tunnel readiness, prints the exact connection method for ChatGPT, copies the URL/Tunnel ID to the clipboard, and can switch cleanly between both tunnel modes.
- GitHub source distribution is intentionally private-from-npm (`package.json` keeps the upstream internal package name for compatibility but sets `private: true`).

### Fixed

- OpenCode availability no longer reports a false positive when its executable is missing.
- Large image reads no longer fall into the old text-size truncation behavior.
- Control Center settings reload on restart instead of reusing stale in-memory configuration.
- Restored Cloudflare Quick Tunnel management in the upstream-first Supervisor and surfaced the active public MCP URL in Control Center.
- Windows PowerShell 5.1 launcher encoding is UTF-8 BOM-safe, preventing non-ASCII status text from breaking script parsing.
- Production dependency audit was reduced to 0 known vulnerabilities through patched transitive dependency resolutions.

### Verification

- `pnpm install --frozen-lockfile`: PASS
- `pnpm audit --prod`: 0 known vulnerabilities
- `pnpm typecheck`: PASS
- `pnpm test`: 139 total / 133 pass / 0 fail / 6 platform-or-optional skips
- `pnpm build`: PASS
- `git diff --check`: PASS
- `npm pack --dry-run`: PASS
