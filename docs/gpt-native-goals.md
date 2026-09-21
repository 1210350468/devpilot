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

## Current browser-continuation slice

The persistent Goal now has a real ChatGPT Web continuation path in the experimental runtime:

1. continuation lease + resume nonce + idempotent round claims;
2. a narrow AsterBridge/RoxyBrowser CDP adapter;
3. ChatGPT page-state detection (`GENERATING`, `IDLE`, `DISCONNECTED`, `LOGIN_REQUIRED`, `RATE_LIMITED`, `CONVERSATION_LIMIT`, `ERROR`);
4. automatic same-chat continuation while a Goal is `running` or `verifying`;
5. cross-chat conversation rotation followed by `goal attach` recovery;
6. a Supervisor-managed watchdog service that sleeps completely when no Goal is continuable.

Remaining work after this slice is primarily product hardening rather than proving the continuation architecture: no-progress/same-failure policy, Control Center Goal controls, broader crash injection, proactive rotation heuristics, and the previously planned PWC latency/cold-start work.

The browser layer should reuse AsterBridge's verified RoxyBrowser endpoint discovery, CDP connection, target ownership, ChatGPT composer/turn binding, terminal-error detection, and bounded page-rebind logic. DevPilot should depend on a narrow browser-adapter contract rather than copy AsterBridge's complete agent/runtime stack.

## Continuation lease protocol

Browser continuation is coordinated in SQLite rather than inferred from timing alone. A continuation claim records:

```text
round_number
lease_owner
lease_until
pending_resume
last_resume_nonce
```

Only `running` and `verifying` Goals are continuable. A watchdog first acquires the lease and round, then sends the prompt. The prompt includes the durable Goal id, round, and resume nonce. The GPT acknowledges it by calling `goal status` or `goal attach` with the same `resume_nonce`. Acknowledgement clears `pending_resume` but leaves the lease in place until the browser observes that turn completing; this prevents another watcher from starting the next round while the current ChatGPT turn is still active.

Claims are idempotent by nonce. If the watcher crashes after sending but before acknowledgement, an expired lease can be reclaimed by another watcher with the same nonce without incrementing the round. A different nonce cannot take an unexpired lease. This bounds crash recovery to at most a retry of the same idempotent continuation prompt rather than silently creating a second logical round.

The continuation claim also enforces `max_rounds` and `max_wall_time_minutes`. Exhaustion transitions the Goal to `blocked`, clears continuation ownership, and prevents automatic browser sends.

## Browser adapter and Watchdog core

The Goal Watchdog is deliberately browser-independent. A narrow `GoalBrowserAdapter` reports one of:

```text
generating
idle
disconnected
login_required
rate_limited
conversation_limit
error
```

and provides only three operations: inspect, send a continuation in the current conversation, or rotate to a new conversation and send a resume prompt. The Watchdog contains Goal/lease policy; the adapter contains browser mechanics.

When a page is `idle`, the Watchdog sends a compact `GOAL_CONTINUE` prompt. When it reports `conversation_limit`, it sends `GOAL_RESUME` in a newly rotated conversation and persists the new browser binding. It never claims a round while ChatGPT is generating or unavailable. `waiting_approval`, `blocked`, paused, terminal, and cancelled Goals are excluded before browser inspection.

Migration 11 adds `goal_browser_bindings`, which stores only transport metadata (adapter id, conversation URL/key, rotation count). It is not task truth and it contains no transcript.

The browser-independent tests cover same-chat continuation, pending acknowledgement, next-round advancement, conversation rotation, concurrent watchdog owners, unavailable/generating states, and crash recovery using the same nonce/round after lease expiry.

## AsterBridge / RoxyBrowser transport

DevPilot reuses the proven transport boundaries from AsterBridge rather than embedding AsterBridge's model/runtime stack. The adapter discovers the configured RoxyBrowser profile from AsterBridge launcher state or its current core config, opens the profile through the loopback Local API when necessary, and attaches to Chromium through `DevToolsActivePort` / CDP. The Roxy Local API key remains referenced by its AsterBridge-owned file path; DevPilot does not copy it into Goal state or logs.

Browser ownership is deliberately fail-closed. A persisted `goal_browser_bindings` record is preferred. If no binding exists, DevPilot may adopt only one uniquely generating normal ChatGPT page; it does not pick an arbitrary idle tab. Existing text in the composer is never overwritten.

Normal persistent Goals also exclude AsterBridge Temporary Chat. `https://chatgpt.com/` and `https://chatgpt.com/?temporary-chat=true` are different transport identities even though their pathname is the same. Conversation rotation always creates a normal ChatGPT conversation.

CDP `Input.insertText` can update the editor before React enables the send button. Real RoxyBrowser testing reproduced this race, so submission waits briefly for the send control to become enabled before declaring failure. It still requires positive submission evidence (a new user/assistant turn or generating state) before returning success.

## Supervisor lifecycle

The experimental DevPilot Supervisor owns a lightweight `GoalWatchdogService`. With no `running` or `verifying` Goal it has no periodic timer. Goal mutations notify it, active Goals arm its polling loop, and terminal/paused/approval/blocked states disarm it. Transitions out of a continuable state clear any in-flight continuation lease immediately.

Shutdown ordering is intentional: stop the watchdog first, close its GoalStore handle, then shut down the MCP server and its independent GoalStore. This prevents a late browser tick from accessing a closed SQLite connection.

Control Center status exposes the watchdog snapshot (`state`, active Goal count, last tick, bounded last outcomes) and the effective tool list includes the top-level `goal` action in addition to the selected Codex/Claude surface.

## Real ChatGPT Web E2E evidence

The experimental `576xx` runtime completed two real web-host validations through the OpenAI Secure MCP Tunnel.

Same-chat continuation: after a normal RoxyBrowser Chat became idle, the watchdog sent `GOAL_CONTINUE`. A fresh ChatGPT turn called `goal status` with the exact resume nonce, verified its required `web_ack` criterion with structured evidence, and called `goal finish`. RequestObserver recorded those remote calls under one real OpenAI conversation scope; the Goal ended `succeeded`, retained its original workspace id, and the watchdog returned to idle.

Cross-chat rotation: the test harness forced only the browser-inspection result to `conversation_limit`; conversation creation, prompt submission, GPT execution, tunnel/MCP calls, and Goal persistence were all real. The watchdog created a new normal ChatGPT conversation and sent `GOAL_RESUME`. That new conversation called `goal attach` with the nonce, retained the same workspace id, verified `rotation_ack`, and finished the Goal successfully.

Neither E2E modified project files or production runtime state.

## ChatGPT plugin schema refresh

The first real web continuation exposed a host cache boundary: the existing `devpilot_pwc_openai` development plugin still advertised its legacy seven-tool schema even though raw `57681/mcp` already returned the new `goal` tool and the PWC v2 `workspace_turn` schema. The GPT correctly refused to invent a `goal` call.

Using ChatGPT Settings → Plugins → `devpilot_pwc_openai` → Update caused OpenAI to issue fresh `tools/list`, `server/discover`, and resource reads. A new ChatGPT conversation then saw and successfully called the top-level `goal` tool. This is another reason Goal is a top-level MCP action instead of another nested `workspace_turn` variant: capability refresh is observable and independently versionable.

During development, after changing the top-level MCP schema, refresh the development plugin and start a fresh Chat before judging host-visible capability. Raw server discovery alone is not evidence that an already-open Chat has refreshed its tool schema.
