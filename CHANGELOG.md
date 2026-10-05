# Changelog

- Prevent one OpenAI Secure Tunnel ID from being consumed by multiple live DevPilot backends via a machine-local tunnel lease, and stop ambient tunnel-config overrides from silently making different checkouts share the same Tunnel ID. Launcher startup now fails fast on tunnel errors instead of waiting the full READY timeout.

## Unreleased — Persistent Workspace Channel v2

- Reduce standalone Codex process-tool stalls that can leave ChatGPT response streams idle: `exec_command` and `write_stdin` now expose a 4s maximum synchronous wait to the model, and passive `write_stdin` polling defaults to 2s instead of 5s. Long-running commands continue through process session IDs and repeated short polls rather than one 12s MCP request.
- Keep batched `workspace_turn` process work from holding one ChatGPT MCP request open for tens of seconds: batched execs now default to 750ms, polls to 1000ms, and all process waits in one turn share a 6s synchronous budget before returning process session IDs for follow-up polling. Standalone process tools use their own shorter host-facing wait cap.
- Add end-to-end connection diagnostics for intermittent ChatGPT hangs: the Request Observer now summarizes a five-minute local MCP window with running/failed/slow/very-slow counts, P95/max duration, latest arrival time, and the oldest running call; the Supervisor records OpenAI Secure Tunnel `/readyz` transitions and surfaces both in the Control Center so upstream delivery delays can be separated from local tool execution time.
- Add proactive Goal conversation rotation based on observable ChatGPT DOM pressure (assistant turns, total visible turns, and visible conversation characters), reusing the existing `GOAL_RESUME` recovery path without pretending to know private model token usage.
- Add a bounded project Markdown heading index to Persistent Context. It ranks source Markdown against the current Goal and exposes paths/headings/line numbers without copying source bodies; a multi-megabyte regression verifies that large handoff corpora stay external while hydration remains bounded.
- Cache project Markdown discovery briefly and reuse heading parses while source size/mtime is unchanged, avoiding repeated large-tree walks during several Goal calls in one ChatGPT turn without making the cache authoritative.
- Report recovery `generated_at` as the actual refresh time while keeping the stable source-revision timestamp inside derived Markdown, avoiding misleading cache timestamps without forcing unchanged context files to be rewritten on every status call.
- Enforce `max_no_progress_rounds` and `max_same_failure` as persistent continuation guards. Migration 12 stores only compact progress/failure fingerprints and counters; unchanged durable Goal state or a repeatedly recorded failure blocks automatic continuation, while idempotent same-nonce crash retries do not consume the guard budget.
- Start the GPT-native Persistent Goal runtime as the next PWC slice. A new top-level `goal` MCP tool persists objective, acceptance criteria, evidence, compact resume state, cross-conversation attachments, and an append-only event journal in the existing DevPilot SQLite database; the ChatGPT host remains the reasoning agent and no local model is required.
- Add SQLite migration 10 (`persistent-goals`) with goal, criterion, conversation-binding, and event tables linked to the existing workspace-session lifecycle.
- Make Goal completion fail closed: `goal finish` returns `GOAL_NOT_COMPLETE` while any required criterion is not verified as passed, so a browser continuation layer can rely on durable Goal state instead of assistant prose.
- Validate that a Goal created in one OpenAI conversation can attach to a second conversation and continue against the same persisted workspace session without copying the old chat transcript.
- Add durable continuation lease/nonce/round coordination for browser-driven Goal turns. Competing watchdog owners cannot double-send a round; an unacknowledged send can be reclaimed after lease expiry using the same nonce and round, and round/wall-time budget exhaustion moves the Goal to `blocked`.
- Add migration 11 for Goal browser bindings and a browser-independent continuation watchdog state machine covering idle/generating/unavailable/conversation-limit states, same-chat continuation, cross-chat rotation, acknowledgement, crash retry, and duplicate-watchdog races.
- Connect the Goal watchdog to the real AsterBridge/RoxyBrowser transport through a narrow CDP browser adapter. It discovers the existing RoxyBrowser profile from launcher/core configuration, keeps API-key material in AsterBridge-owned secret files, refuses to overwrite user drafts, and fails closed instead of injecting into an arbitrary ChatGPT tab.
- Keep persistent Goals off AsterBridge Temporary Chat surfaces and distinguish `/?temporary-chat=true` from a normal durable Chat even though both share the `/` pathname.
- Add a lightweight Supervisor-managed Goal Watchdog service that has no polling timer while no `running`/`verifying` Goals exist, wakes on Goal state changes, clears continuation leases when a Goal enters a non-continuable state, and shuts down before the Goal SQLite handle.
- Harden real browser prompt submission by allowing ChatGPT's React composer up to three seconds to hydrate the send button after CDP text insertion instead of treating the transient disabled state as a failed send.
- Validate a real ChatGPT Web same-conversation continuation through the experimental OpenAI Secure MCP Tunnel: Watchdog `GOAL_CONTINUE` → GPT `goal status` with `resume_nonce` → criterion verification → `goal finish`, with the original persisted workspace retained and no project-file changes.
- Validate a real cross-conversation recovery path: a forced conversation-limit boundary created a new normal ChatGPT conversation, sent `GOAL_RESUME`, and the new GPT turn used `goal attach` with the nonce before verifying and finishing against the same workspace session.
- Confirm and document ChatGPT plugin schema caching: an existing `devpilot_pwc_openai` connector continued exposing the legacy seven-tool schema until its development plugin was refreshed; the refresh triggered fresh `tools/list` / `server/discover`, after which a new Chat saw and successfully called the top-level `goal` tool.
- Reduce the default Codex `exec_command` yield from 10 seconds to 2 seconds so long builds/tests hand control back to ChatGPT quickly with a process session id; explicit callers may still request up to the existing 12-second maximum.
- Allow `workspace_turn` to omit `workspace_id` when the current Chat resolves unambiguously to one workspace. An attached non-terminal Goal takes precedence, ordinary multi-workspace Chats fail closed, and the resolved id is returned in structured output for later explicit tool calls.
- Expose the derived Goal hydration refs in structured `goal` output as `recovery_context` (in addition to the human-readable tool content), so real ChatGPT connector turns can discover `@context/<goal>/hydrate.md` without reconstructing or guessing the path.
- Add a bounded Persistent Context Store for long Goal recovery without replaying old Chat transcripts. Goal state is projected into disposable Markdown under DevPilot `stateDir`; Goal responses advertise `@context/<goal_id>/hydrate.md`, and both `read` and `workspace_turn` can read the allowlisted virtual context paths without adding another MCP tool or database migration.
- Add deterministic adaptive hydration profiles (`minimal`, `normal`, `debug`, `verification`) with a 12k-character first-read budget and separately bounded state/decision/failure/evidence/history files. The cache is explicitly non-authoritative: Goal DB remains Goal truth and Git/filesystem remains workspace truth.

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
