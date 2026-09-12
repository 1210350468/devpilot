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
