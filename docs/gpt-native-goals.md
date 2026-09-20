# GPT-native Persistent Goals

DevPilot Goals are a durable task runtime for ChatGPT Web. The ChatGPT model remains the reasoning agent; DevPilot stores task state, executes local tools, and provides recovery facts. Browser automation may resume or rotate conversations, but it must not become a second reasoning agent.

## Invariants

- Goal lifetime is independent from ChatGPT conversation lifetime.
- Chat transcripts are not Goal state and are not copied into SQLite.
- One Goal owns one persisted DevPilot workspace session; multiple ChatGPT conversations may attach to it over time.
- Git/filesystem state remains workspace truth. Goal state records objective, decisions, acceptance evidence, and recovery metadata only.
- Local Codex, Claude, OpenCode, Pi, and local LLMs are optional integrations, not the default Goal brain.
- Production deployment, destructive operations, publishing, spending, and other approval-gated actions must stop the Goal before execution.

## Current v1 persistence slice

Migration 10 adds four tables to the existing DevPilot SQLite database:

- `goals` — objective, state, compact recovery fields, budgets, round metadata, and future continuation lease fields.
- `goal_criteria` — required/optional acceptance criteria with structured evidence and verification metadata.
- `goal_conversation_bindings` — maps each OpenAI conversation scope to the Goal it is currently continuing. Many conversations may point to one Goal.
- `goal_events` — append-only, bounded-retrieval journal of externally useful decisions and facts. It does not store hidden reasoning or a transcript.

The initial top-level `goal` MCP surface intentionally uses one stable action-oriented schema rather than repeatedly expanding `workspace_turn`'s nested union. This avoids the host schema-cache failure already observed during PWC v2 testing.

Supported actions in the first slice are:

```text
start
attach
status
update
checkpoint
verify
finish
pause
resume
request_approval
approve
block
fail
cancel
history
```

`start` binds the Goal to an already-open DevPilot workspace and, when OpenAI conversation metadata is present, attaches that conversation. `attach` lets a later ChatGPT conversation continue the same Goal and workspace. Calls without `goal_id` resolve the Goal from the current conversation attachment when unambiguous.

## Acceptance criteria and evidence

Criteria are first-class state:

```text
pending
passed
failed
blocked
```

Evidence is compact and structured (`kind`, `summary`, optional `ref`). `finish` checks all required criteria and fails with `GOAL_NOT_COMPLETE` until every required criterion is `passed`. Assistant wording is therefore not completion authority.

## Resume Capsule

The Goal stores a bounded Resume Capsule for cross-turn and cross-conversation recovery. It may contain objective, completed/remaining work, hard constraints, decisions, current state/problem, next actions, failed strategies, and evidence summaries. The Capsule is deliberately much smaller than a chat transcript.

A future rotated Chat should receive only a short trigger such as:

```text
GOAL_RESUME <goal_id>
resume_nonce=<nonce>

Attach this conversation to the existing Goal through DevPilot MCP.
Load the Resume Capsule and workspace delta.
Do not reconstruct the task from old chat history.
Continue from the persisted next step.
```

## Goal Journal

Important externally useful state changes are appended to `goal_events`, for example Goal creation, conversation attachment, checkpoint, verification, approval requests, block/failure, and completion. History retrieval is bounded. Raw command logs, secrets, and hidden chain-of-thought do not belong in the journal.

## Next implementation slices

The core persistence/tool surface is only the first slice. The remaining Goal runtime work is:

1. continuation lease + resume nonce + idempotent round claims;
2. browser adapter based on the proven AsterBridge RoxyBrowser/CDP primitives;
3. robust ChatGPT page state (`GENERATING`, `IDLE`, `DISCONNECTED`, `LOGIN_REQUIRED`, `RATE_LIMITED`, `CONVERSATION_LIMIT`, `ERROR`);
4. automatic same-chat continuation while Goal is `running` or `verifying`;
5. cross-chat conversation rotation and `goal attach` recovery;
6. no-progress/same-failure budgets and automatic transition to `blocked`;
7. Control Center Goal visibility and controls;
8. crash-injection and real ChatGPT Web E2E validation.

The browser layer should reuse AsterBridge's verified RoxyBrowser endpoint discovery, CDP connection, target ownership, ChatGPT composer/turn binding, terminal-error detection, and bounded page-rebind logic. DevPilot should depend on a narrow browser-adapter contract rather than copy AsterBridge's complete agent/runtime stack.
