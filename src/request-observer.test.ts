import assert from "node:assert/strict";
import test from "node:test";
import { RequestObserver } from "./request-observer.js";

test("request observer isolates conversations and inherits conversation from MCP session", () => {
  const observer = new RequestObserver(20);

  observer.start({
    id: "a1",
    startedAt: "2026-08-21T01:00:00.000Z",
    method: "POST",
    path: "/mcp",
    mcpMethod: "tools/call",
    toolName: "read",
    conversationScopeId: "chat-a",
    mcpSessionId: "mcp-a",
  });
  observer.finish("a1", {
    completedAt: "2026-08-21T01:00:00.010Z",
    status: 200,
    durationMs: 10,
  });

  observer.start({
    id: "b1",
    startedAt: "2026-08-21T01:00:01.000Z",
    method: "POST",
    path: "/mcp",
    mcpMethod: "tools/call",
    toolName: "exec_command",
    conversationScopeId: "chat-b",
    mcpSessionId: "mcp-b",
  });

  observer.start({
    id: "a2",
    startedAt: "2026-08-21T01:00:02.000Z",
    method: "POST",
    path: "/mcp",
    mcpMethod: "notifications/progress",
    mcpSessionId: "mcp-a",
  });

  assert.deepEqual(observer.list(20, "chat-a").map((entry) => entry.id), ["a2", "a1"]);
  assert.deepEqual(observer.list(20, "chat-b").map((entry) => entry.id), ["b1"]);
  assert.equal(observer.list(20).find((entry) => entry.id === "a2")?.conversationScopeId, "chat-a");

  const conversations = observer.conversations();
  assert.deepEqual(conversations.map((conversation) => conversation.id), ["chat-a", "chat-b"]);
  assert.equal(conversations[0]?.requestCount, 2);
  assert.equal(conversations[0]?.toolCallCount, 1);
  assert.equal(conversations[1]?.requestCount, 1);
  assert.equal(conversations[1]?.toolCallCount, 1);
});

test("request observer leaves unrelated requests unidentified", () => {
  const observer = new RequestObserver();
  observer.start({
    id: "unknown",
    startedAt: "2026-08-21T01:00:00.000Z",
    method: "POST",
    path: "/mcp",
    mcpMethod: "initialize",
    mcpSessionId: "unbound-session",
  });

  assert.equal(observer.list()[0]?.conversationScopeId, undefined);
  assert.deepEqual(observer.conversations(), []);
});

test("request diagnostics distinguish healthy, slow, failed, and running MCP calls", () => {
  const observer = new RequestObserver(20);
  const nowMs = Date.parse("2026-10-05T01:00:30.000Z");

  observer.start({
    id: "fast",
    startedAt: "2026-10-05T01:00:20.000Z",
    method: "POST",
    path: "/mcp",
    mcpMethod: "tools/call",
    toolName: "read",
  });
  observer.finish("fast", {
    completedAt: "2026-10-05T01:00:20.120Z",
    status: 200,
    durationMs: 120,
  });

  observer.start({
    id: "slow",
    startedAt: "2026-10-05T01:00:10.000Z",
    method: "POST",
    path: "/mcp",
    mcpMethod: "tools/call",
    toolName: "workspace_turn",
  });
  observer.finish("slow", {
    completedAt: "2026-10-05T01:00:22.000Z",
    status: 200,
    durationMs: 12_000,
  });

  observer.start({
    id: "failed",
    startedAt: "2026-10-05T01:00:24.000Z",
    method: "POST",
    path: "/mcp",
    mcpMethod: "tools/call",
    toolName: "apply_patch",
  });
  observer.finish("failed", {
    completedAt: "2026-10-05T01:00:24.050Z",
    status: 500,
    durationMs: 50,
  });

  observer.start({
    id: "running",
    startedAt: "2026-10-05T01:00:12.000Z",
    method: "POST",
    path: "/mcp",
    mcpMethod: "tools/call",
    toolName: "exec_command",
  });

  const diagnostics = observer.diagnostics({ nowMs });
  assert.equal(diagnostics.state, "error");
  assert.equal(diagnostics.receivedCount, 4);
  assert.equal(diagnostics.completedCount, 3);
  assert.equal(diagnostics.runningCount, 1);
  assert.equal(diagnostics.failedCount, 1);
  assert.equal(diagnostics.slowCount, 2);
  assert.equal(diagnostics.verySlowCount, 1);
  assert.equal(diagnostics.maxDurationMs, 12_000);
  assert.equal(diagnostics.p95DurationMs, 12_000);
  assert.equal(diagnostics.latestRequestAt, "2026-10-05T01:00:24.000Z");
  assert.equal(diagnostics.oldestRunning?.id, "running");
  assert.equal(diagnostics.oldestRunning?.elapsedMs, 18_000);
  assert.deepEqual(diagnostics.recentSlow.map((entry) => entry.id), ["running", "slow"]);
});

test("request diagnostics ignore non-MCP traffic and old requests", () => {
  const observer = new RequestObserver(20);
  const nowMs = Date.parse("2026-10-05T01:10:00.000Z");
  observer.start({
    id: "asset",
    startedAt: "2026-10-05T01:09:59.000Z",
    method: "GET",
    path: "/mcp-app-assets/app.js",
  });
  observer.finish("asset", {
    completedAt: "2026-10-05T01:09:59.010Z",
    status: 200,
    durationMs: 10,
  });
  observer.start({
    id: "protocol-probe",
    startedAt: "2026-10-05T01:09:58.000Z",
    method: "POST",
    path: "/mcp",
  });
  observer.finish("protocol-probe", {
    completedAt: "2026-10-05T01:09:58.001Z",
    status: 415,
    durationMs: 1,
  });
  observer.start({
    id: "old",
    startedAt: "2026-10-05T01:00:00.000Z",
    method: "POST",
    path: "/mcp",
    mcpMethod: "tools/list",
  });
  observer.finish("old", {
    completedAt: "2026-10-05T01:00:00.020Z",
    status: 200,
    durationMs: 20,
  });

  const diagnostics = observer.diagnostics({ nowMs, windowMs: 60_000 });
  assert.equal(diagnostics.state, "quiet");
  assert.equal(diagnostics.receivedCount, 0);
  assert.equal(diagnostics.latestRequestAt, undefined);
});

test("request diagnostics mark a completed five-second call as slow", () => {
  const observer = new RequestObserver();
  observer.start({
    id: "slow-only",
    startedAt: "2026-10-05T01:00:00.000Z",
    method: "POST",
    path: "/mcp",
    mcpMethod: "tools/call",
    toolName: "exec_command",
  });
  observer.finish("slow-only", {
    completedAt: "2026-10-05T01:00:06.000Z",
    status: 200,
    durationMs: 6_000,
  });

  const diagnostics = observer.diagnostics({ nowMs: Date.parse("2026-10-05T01:00:07.000Z") });
  assert.equal(diagnostics.state, "slow");
  assert.equal(diagnostics.slowCount, 1);
  assert.equal(diagnostics.verySlowCount, 0);
});
