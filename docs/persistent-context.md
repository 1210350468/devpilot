# Persistent Context Store and Adaptive Hydration

DevPilot keeps long-running ChatGPT work recoverable without treating the Chat transcript as durable task state. The Persistent Context Store is a bounded, derived Markdown cache that exposes the most useful Goal recovery facts through normal DevPilot reads.

The feature optimizes context delivery; it does not create a new source of truth.

## Authority model

The recovery stack has four distinct layers:

1. **Goal DB** — authoritative Goal identity, status, acceptance criteria, evidence, Resume Capsule, continuation metadata, and durable Goal journal.
2. **Git / filesystem** — authoritative workspace state.
3. **Persistent Context Store** — disposable, bounded Markdown projections of Goal recovery state.
4. **Chat transcript** — current host interaction history, not durable Goal truth.

If a context file conflicts with Goal state or the workspace, the Goal DB and workspace win. Context files may be deleted and regenerated without changing task correctness.

## Storage and isolation

Context files live below DevPilot's configured `stateDir`, not inside the user's project checkout:

```text
<stateDir>/goal-context/<workspace_id>/<goal_id>/
  hydrate.md
  manifest.md
  state.md
  decisions.md
  failures.md
  evidence.md
  history.md
```

The model never needs the physical state-directory path. Goal responses advertise virtual read references such as:

```text
@context/goal_.../hydrate.md
@context/goal_.../manifest.md
```

Successful `goal` responses also expose these refs in structured output under `recovery_context`, including `hydrate_ref`, `manifest_ref`, the selected hydration profile, and source timestamps. Hosts should start with `hydrate_ref` and expand through the manifest only when the current step requires more detail.

`read` and `workspace_turn` resolve those references only inside the current workspace's Goal-context directory. The virtual path grammar and file names are allowlisted, so `..` traversal and arbitrary state-directory reads fail closed.

No database migration is required. No top-level MCP tool is added, which also avoids another ChatGPT connector schema-refresh boundary.

## Hydration flow

A Goal mutation or status/attach call best-effort refreshes the derived cache and returns a short hint to read `hydrate.md`. Cache generation failure never changes the result of the authoritative Goal operation.

Fresh or rotated Chats should recover in this order:

```text
GOAL_RESUME / goal.attach
        ↓
Goal Resume Capsule
        ↓
@context/<goal>/hydrate.md
        ↓
only relevant topic files
        ↓
workspace delta / source reads when authoritative current state is required
```

The first hydration file is capped at 12,000 characters. The manifest is capped at 8,000 characters, topic files at 24,000 characters each, and history includes at most the latest 30 durable Goal events. `workspace_turn` applies its own aggregate result budget on top of those file-level limits.

The store never copies raw Chat transcripts or hidden reasoning. `history.md` contains only the same bounded durable event metadata already present in the Goal journal.

## Adaptive hydration profiles

The cache chooses a deterministic profile from current Goal state:

- `minimal` — objective, focus, constraints, remaining required criteria, and next actions.
- `normal` — minimal state plus durable decisions carried by the Resume Capsule.
- `debug` — normal state plus known failed strategies / traps.
- `verification` — current state plus compact verification evidence.

The profile changes what appears in the first `hydrate.md`; it does not hide the topic files. When recovery is uncertain, the host can expand through `manifest.md` and then inspect authoritative source state.

This is intentionally simpler than semantic/vector retrieval. Heading/topic references remain deterministic and inspectable. Semantic retrieval should be added only if real workloads demonstrate that the bounded deterministic index misses required context.

## Staleness and invalidation

The cache is refreshed from the latest Goal record and bounded Goal events whenever the Goal MCP surface is used. Generated Markdown includes the Goal update/source version and an explicit non-authoritative banner.

Workspace changes are not copied into the cache. A fresh Chat should use the existing workspace checkpoint/delta path, Git, or focused file reads before relying on cached descriptions of source state. This keeps external filesystem edits, changed `AGENTS.md`, new commits, and non-Git mutations in their proper authority layer instead of trying to mirror them into a second database.

## Why this differs from uploading one large Markdown handoff

Moving 100k tokens from a Chat message into one Markdown file does not remove the model cost if every new turn reads the entire file. Persistent Context instead separates a small recovery entry point from larger optional topics and raw source state. A long Goal can therefore accumulate work far beyond one conversation while a new Chat hydrates only the subset needed for its current step.

The target is not an infinitely long Chat. The target is a replaceable ChatGPT conversation that can attach to the same durable Goal/workspace and cheaply reconstruct the current working set.
