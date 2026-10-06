# Persistent Workspace Channel v2 (experimental)

This experimental DevPilot layer reduces repeated MCP round trips without moving orchestration away from the host model.

## Goals

- Open a checkout once per ChatGPT conversation and keep reusing its `workspace_id`.
- Cache expensive workspace bootstrap discovery instead of recursively rescanning AGENTS / CLAUDE context on every repeated `open_workspace` call.
- Let the host batch operations that are already known in advance through `workspace_turn`.
- Keep adaptive reasoning in ChatGPT: when one result determines the next action, return to the host instead of hiding the workflow in a local autonomous loop.

## Context reuse

Conversation-scoped checkout bindings remain the source of workspace identity. A live `Workspace` now retains its loaded AGENTS files and nested instruction discovery. Reopening the same project in the same conversation reuses that cached Bootstrap Context.

Use `refresh_context=true` on `open_workspace` when instruction files, skills, or agent profiles were intentionally changed and must be rediscovered immediately.

## `workspace_turn`

The Codex surface adds one batching primitive:

```text
workspace_turn
```

It accepts up to eight ordered operations:

- `read` — read a workspace or advertised skill file.
- `exec` — start a shell command with the existing process-session manager.
- `poll` — poll or write to a process session returned by an earlier command.

The tool is deliberately not an autonomous agent. It executes only operations explicitly supplied by the host. File edits remain in `apply_patch`, and aggregate review remains in `show_changes`, preserving the existing review and safety boundaries.

Each returned step also includes its model-readable `result`, so hosts that prioritize structured content still receive the file or command output produced by the batch.

Detailed step output is emitted only in `structuredContent`; the ordinary text `content` field remains a compact turn summary so large reads are not duplicated inside the same MCP response.

Recommended interaction pattern:

```text
open_workspace        # once
workspace_turn        # inspect several known files / commands together
<host reasons>
apply_patch           # coherent edit
workspace_turn        # run known validation commands / reads together
show_changes          # final review
```

This should reduce a typical 10–20-tool interactive task to a few host/tool round trips while keeping the host as the orchestrator.

## Validation plan

The feature is developed in an isolated worktree before any merge to `main`:

1. Typecheck and focused workspace/server regression tests.
2. Full test suite and build.
3. Measure repeated `open_workspace` latency on a large GTNH workspace.
4. Run an isolated MCP instance on separate ports.
5. Connect a separate ChatGPT test connector and compare tool-call count, wall latency, output/context volume, and correctness against the current release.

Promotion to `main` should happen only after the isolated ChatGPT A/B is satisfactory.

## 2026-09-19 ChatGPT / OpenAI Secure Tunnel A/B

The isolated PWC connector was exercised through its own OpenAI Secure MCP Tunnel rather than only through local unit tests.

- GTNH repeated `open_workspace`: release path `3494 ms`; PWC warm cache `13 ms` in the same conversation.
- GTNH cold/restart recovery initially regressed to `18410 ms`. Replacing serial depth-first instruction discovery with bounded concurrent breadth-first discovery reduced the same recovery path to `3718 ms` without changing nested AGENTS / CLAUDE discovery semantics.
- GTNH inspection batch: four file reads plus one short command completed as one `workspace_turn` in `264 ms`, replacing five separate host-facing tool calls.
- ForgeFit inspection batch: three file reads plus `git status` completed as one `workspace_turn` in `138 ms`, replacing four separate host-facing tool calls. The corresponding release `open_workspace` measured `5870 ms`; PWC measured `4562 ms` on that cold sample.
- A one-read raw MCP sample originally duplicated detailed output in both `content` and `structuredContent` (`3668` bytes, the file text appearing twice). Keeping details only in structured step results reduced the same response to `1963` bytes with one copy while remaining readable by the real ChatGPT connector.
- Final full suite after these changes: `141` tests / `135` pass / `0` fail / `6` platform-or-optional skips.

These measurements support the v1 direction: keep ChatGPT as orchestrator, cache workspace bootstrap state, and batch only operations whose next steps are already known.

## v2: task checkpoint, delta, and resume

v2 extends the same host-orchestrated design without adding another top-level MCP tool.

`workspace_turn` gains two bounded operations:

- `checkpoint` persists a concise task `status`, `summary`, optional `next_step`, and a Git working-tree snapshot for the current conversation-scoped workspace session.
- `delta` compares the current working tree with that checkpoint and returns only bounded changed paths plus aggregate addition/removal counts. It intentionally does not inject a full patch.

Task state is stored in the existing DevSpace SQLite workspace database and is keyed by `workspace_session_id`. Because checkout workspaces are already conversation-scoped, separate ChatGPT conversations do not silently share task state. The checkpoint row is removed with its workspace session through the existing foreign-key lifecycle.

When the same conversation reopens a persisted checkout, `open_workspace` returns a compact optional `resume` object:

```text
status
summary
next_step
updated_at
```

The model-facing instruction recommends checking `workspace_turn` delta before broadly rereading project documents. This is the intended path for short prompts such as “continue”: recover the durable checkpoint, inspect only filesystem changes since it, then reason in the host.

The checkpoint is deliberately not a hidden local plan or autonomous loop. It stores no transcript and executes no future action on its own. `summary` is capped at 1600 characters, `next_step` at 800 characters, and delta paths at 50 entries maximum. Adaptive decisions, edits, and final review remain host-controlled.

## Context budget

Batching must not trade fewer MCP calls for unbounded prompt growth. `workspace_turn` therefore applies a total model-readable step-result budget after execution. The default is `32,000` characters and callers may request `4,000..96,000` through `max_result_chars`.

The budget is distributed fairly over the remaining steps rather than first-come-first-served. Short results return unused capacity to later steps; oversized results are trimmed to their current fair share and carry `result_truncated=true` plus an explicit instruction to use a focused `read` or `exec` when more detail is necessary. Checkpoint and delta metadata remain separately structured, so truncating a large file body does not erase task-state fields.

## Persistent Context Store

Long Goal recovery now adds a second bounded layer above the workspace checkpoint without making the Chat transcript durable state. Each Goal can project its Resume Capsule, criteria/evidence, and recent Goal journal into disposable Markdown files under DevPilot `stateDir`. Goal responses advertise virtual `@context/<goal_id>/*.md` paths; both `read` and the existing `workspace_turn` `read` operation can consume them, so no extra top-level MCP tool or schema migration is needed.

The normal recovery path is `Goal attach/status → hydrate.md → relevant topic file(s) → workspace delta/source reads`. `hydrate.md` is capped at 12k characters and chooses a deterministic minimal/normal/debug/verification profile. Topic files remain separately bounded, and `workspace_turn` still applies its aggregate result budget. The context cache never owns workspace facts: it is a derived acceleration index that may be discarded and regenerated. See `docs/persistent-context.md`.

The same recovery layer now includes a bounded project Markdown heading index. It stores paths/headings/line numbers rather than source bodies, ranks likely documents against the current Goal, and lets the host jump into the authoritative source with focused `read` calls. A synthetic multi-megabyte Markdown regression keeps the first hydration under 12k characters and the project index under 24k while leaving the source corpus external.

Goal browser continuation also supports proactive rotation based on observable DOM pressure (assistant turns, total visible turns, and visible conversation characters). It does not infer or fabricate token usage. Crossing a safety threshold while the page is idle takes the already-tested cross-Chat `GOAL_RESUME` path before a hard `conversation_limit` boundary is reached.

The previously reserved Goal budgets for no-progress and repeated-failure handling are now enforced. New logical continuation rounds compare a fingerprint of durable Goal/criterion state with the previous round boundary and separately fingerprint the latest durable failure. Unchanged state or the same failed strategy blocks automatic continuation at the configured budget instead of allowing an infinite browser loop; idempotent retry of the same resume nonce is excluded from these counters.

## Connection diagnostics

The local Control Center now exposes enough timing evidence to distinguish a slow local MCP call from a delay before the request reaches DevPilot. `RequestObserver` keeps its existing bounded request history and derives a five-minute diagnostic window containing received/completed/running/failed counts, calls over 5 seconds and 15 seconds, local P95/max duration, the latest MCP arrival, and the oldest still-running call. These are local timings measured from the instant the DevSpace HTTP server receives the request; they do not claim to measure private ChatGPT or OpenAI queue time.

The Supervisor also samples the OpenAI Secure Tunnel loopback `/readyz` endpoint every five seconds while the tunnel is starting or running and records only readiness transitions. The Control Center shows the current readiness streak and recent transition timing. When ChatGPT appears stuck while the latest MCP arrival timestamp is not advancing, the available evidence points upstream of the local MCP server (Connector host, Secure Tunnel, proxy, or network). When the request has arrived and a running/slow local request is visible, the delay is attributable to local MCP/tool execution. This diagnostic boundary is intentionally explicit: DevPilot cannot timestamp an OpenAI request that never reached the machine.

## Process-session lifecycle

Long-running commands no longer become unbounded DevPilot sessions merely because they outlive the initial yield window. Non-interactive sessions use a renewable idle lease: by default a running session is automatically terminated after 30 seconds without a client poll/write. Each `write_stdin` poll or interaction renews that lease. Interactive PTY sessions default to persistent behavior, and callers can explicitly set `auto_close=false` for another intentionally persistent session. This approximates ChatGPT turn-end cleanup without depending on a browser-private "turn ended" event that MCP does not reliably receive.

`max_runtime_ms` optionally sets a hard wall-time limit independent of polling. On timeout or explicit termination DevPilot reuses its existing process-tree cleanup: POSIX pipe commands run in a detached process group and are terminated through the group PID, while Windows uses `taskkill /T /F`; a short escalation window follows SIGTERM before SIGKILL and forced session reap.

`detach=true` is for launchers whose durable work has already been backgrounded outside the local MCP process, such as a remote `nohup`/`setsid` job. DevPilot gives the launcher its normal short initial yield so startup output such as a PID can be captured; if the local launcher is still alive afterward, DevPilot terminates that local launcher/process tree, closes the transport, and retains no `session_id`. Detached PTY commands are rejected. Detach is therefore an explicit declaration that the caller no longer needs DevPilot to manage or interact with the local launcher process, and the durable job must already be independent of that local process tree.

### Host schema-cache compatibility

The v2 experiment intentionally keeps the top-level Codex surface at seven tools. Real ChatGPT testing showed that changing only the nested `workspace_turn` operation union does not necessarily refresh an already-connected host's cached schema, even after the MCP server restarts and its own `tools/list` reports the new `checkpoint` and `delta` variants. A freshly discovered connector receives the server schema correctly. Treat this as a host-discovery compatibility boundary rather than a server-state failure; runtime validation therefore checks both the server's raw `tools/list` and the host-visible tool schema.

### Runtime restart validation

The OpenAI Secure Tunnel experiment also exposed a launcher lifecycle defect unrelated to task persistence: `runtime.json` stores `supervisorPid`, while the stop script still looked only for legacy `pid`. The script now prefers `supervisorPid` with `pid` as a compatibility fallback. A live stop test terminated the reported Supervisor PID and released all three experimental ports before restart. After restart, the same synthetic OpenAI conversation scope recovered the same workspace ID and task checkpoint, and `delta` still reported only the post-checkpoint documentation edit.

## Next layer: GPT-native Goals

PWC v2 keeps a task checkpoint scoped to one workspace/conversation recovery path. Longer autonomous work needs a higher-level identity whose lifetime is not tied to one ChatGPT conversation. The GPT-native Goal layer builds on PWC rather than replacing it: one Goal owns a workspace session, while multiple ChatGPT conversations can attach to the Goal and recover its compact Resume Capsule, acceptance criteria, evidence, journal, and next step. See `docs/gpt-native-goals.md`.

## Production promotion rehearsal

Before any production promotion, the candidate was exercised against copies of the currently installed DevPilot configuration and runtime metadata in isolated detached worktrees. The rehearsal exposed several upgrade-path issues that ordinary feature tests did not cover.

The installed production configuration is a legacy `config.json`, not the upstream-first `config.jsonc` format. It contains DevPilot-specific `authMode`, `toolMode`, and `widgets` fields. The compatibility migration now accepts exactly those identified fields in addition to the older upstream legacy shape, maps legacy tool modes onto the Codex surface, maps widget state onto the upstream UI toggle, and keeps unknown legacy keys fail-closed. `authMode` is validated but not persisted into the new upstream config because tunnel provider selection remains a launcher/runtime concern rather than a second configuration truth source.

The launcher also preserves upgrade identity instead of treating an installed legacy deployment as a fresh install. If `config.jsonc` is absent but legacy `config.json` exists, the launcher does not write default configuration over it. The runtime performs an atomic migration and retains `config.json.v1.0.bak`. When no port arguments are explicitly supplied, the launcher reuses valid MCP, Control Center, and tunnel-health ports from the previous `runtime.json`; explicit command-line overrides still win.

One rehearsal exposed an unrelated global DevSpace SQLite database whose migration version 6 was named `task-runtime`, while this candidate expects `local-agent-effort-rename`. The legacy production configuration did not define a state directory, so blindly accepting the upstream global default would make DevPilot attach to that unrelated database and fail startup. The upgrade preflight now fills only missing legacy `stateDir` and `worktreeRoot` values with project-local `.devpilot-runtime/state` and `.devpilot-runtime/worktrees` paths before MCP startup. Existing explicit custom paths remain unchanged.

The final isolated one-click rehearsal used copies of the production legacy config/runtime, remapped only to non-production test ports, and exercised the normal Windows launcher path from a clean detached worktree. It completed first `pnpm install`, first production build, atomic legacy migration, local SQLite migrations 1 through 9, MCP startup, Cloudflare Quick Tunnel establishment, and launcher READY. The migrated config retained all six production allowed roots, `subagents=false`, the expected Codex tool surface, and `uiEnabled=false` from legacy `widgets=off`. The rehearsal was then stopped through the normal stop launcher and all test ports were released.

Production isolation was checked during the rehearsal: the live `7680 / 7681` Supervisor PID and `7683` tunnel PID did not change. No production config, state database, checkout, or tunnel was modified.

Rollback was rehearsed separately instead of assuming database downgrades are safe. Restoring the generated `config.json.v1.0.bak` as legacy `config.json` allowed the production baseline build to recover its original `toolMode=full`, `widgets=off`, `authMode=secure-tunnel`, six allowed roots, and disabled subagents. This means a future failed promotion can roll back code plus the legacy config backup without asking the older build to open the new v2 SQLite state; the project-local candidate state can remain isolated for diagnosis or later cleanup.
