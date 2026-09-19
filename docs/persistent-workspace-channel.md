# Persistent Workspace Channel v1

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
