import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer, createServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { GoalStore } from "./goal-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

test("tool modes expose the expected host-facing tool surface", async (t) => {
  const cases: Array<{
    mode: ToolMode;
    expected: string[];
  }> = [
    {
      mode: "claude",
      expected: ["open_workspace", "read", "write", "edit", "bash", "goal", "show_changes"],
    },
    {
      mode: "codex",
      expected: ["open_workspace", "read", "apply_patch", "exec_command", "write_stdin", "workspace_turn", "goal", "show_changes"],
    },
  ];

  for (const { mode, expected } of cases) {
    await t.test(mode, async (nested) => {
      const context = await fixture(nested, { toolMode: mode, uiEnabled: false });
      const tools = await context.client.listTools();

      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        expected.sort(),
      );
    });
  }
});

test("persistent goal attaches across ChatGPT conversations and refuses premature completion", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const opened = structuredContent(await callOpen(context.client, context.project, "goal-chat-a"));
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const started = structuredContent(await callGoal(context.client, {
    action: "start",
    workspace_id: workspaceId,
    objective: "Complete a durable test Goal.",
    criteria: [{ id: "tests", description: "Focused tests pass." }],
    constraints: ["Do not touch production."],
    next_step: "Run the focused test.",
  }, "goal-chat-a"));
  const startedGoal = started.goal as Record<string, unknown>;
  const goalId = startedGoal.goal_id;
  assert.equal(typeof goalId, "string");
  assert.equal(startedGoal.workspace_id, workspaceId);
  assert.equal(startedGoal.status, "running");

  const sameChat = structuredContent(await callGoal(context.client, { action: "status" }, "goal-chat-a"));
  assert.equal((sameChat.goal as Record<string, unknown>).goal_id, goalId);

  const premature = await callGoal(context.client, { action: "finish" }, "goal-chat-a");
  assert.equal(premature.isError, true);
  assert.equal(structuredContent(premature).error_code, "GOAL_NOT_COMPLETE");

  const attached = structuredContent(await callGoal(context.client, {
    action: "attach",
    goal_id: goalId,
  }, "goal-chat-b"));
  assert.equal((attached.goal as Record<string, unknown>).workspace_id, workspaceId);

  const verified = structuredContent(await callGoal(context.client, {
    action: "verify",
    criterion_updates: [{
      id: "tests",
      status: "passed",
      evidence: [{ kind: "test", summary: "Focused test passed.", ref: "run-1" }],
      verification_source: "server.test.ts",
    }],
  }, "goal-chat-b"));
  assert.equal((verified.goal as Record<string, unknown>).status, "verifying");

  const finished = structuredContent(await callGoal(context.client, { action: "finish" }, "goal-chat-b"));
  assert.equal((finished.goal as Record<string, unknown>).status, "succeeded");
  assert.equal((finished.goal as Record<string, unknown>).workspace_id, workspaceId);
});

test("Goal responses advertise bounded recovery context readable through read and workspace_turn", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const conversationScopeId = "goal-context-chat";
  const opened = structuredContent(await callOpen(context.client, context.project, conversationScopeId));
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const startedResponse = await callGoal(context.client, {
    action: "start",
    workspace_id: workspaceId,
    objective: "Recover a long task with bounded external context.",
    criteria: [{ id: "tests", description: "Context hydration tests pass." }],
    constraints: ["Do not replay the old transcript."],
    next_step: "Debug the recovery cache.",
  }, conversationScopeId);
  const started = structuredContent(startedResponse);
  const goalId = (started.goal as Record<string, unknown>).goal_id;
  assert.equal(typeof goalId, "string");
  const recoveryContext = started.recovery_context as Record<string, unknown>;
  assert.equal(recoveryContext.hydrate_ref, `@context/${goalId}/hydrate.md`);
  assert.equal(recoveryContext.manifest_ref, `@context/${goalId}/manifest.md`);
  assert.equal(recoveryContext.derived, true);
  assert.equal(typeof recoveryContext.generated_at, "string");
  assert.match(String(started.result), new RegExp(`Recovery context: @context/${goalId}/hydrate\\.md`));
  assert.match(JSON.stringify(startedResponse.content), new RegExp(`@context/${goalId}/hydrate\\.md`));

  await callGoal(context.client, {
    action: "checkpoint",
    goal_id: goalId,
    summary: "Debugged the recovery cache; verify the focused suite next.",
    current_step: "Verify context hydration.",
    next_step: "Run focused tests.",
    resume_capsule: {
      decisions: ["Keep Goal DB and Git/filesystem authoritative."],
      current_state: "The derived Markdown cache is available.",
      current_problem: "Need to prove fresh Chat hydration stays bounded.",
      next_actions: ["Read hydrate.md, then run focused tests."],
      failures: ["Do not load the full historical transcript by default."],
      evidence: ["Goal context is stored outside the project checkout."],
    },
  }, conversationScopeId);

  const hydrateRef = `@context/${goalId}/hydrate.md`;
  const direct = await context.client.callTool({
    name: "read",
    arguments: { workspace_id: workspaceId, path: hydrateRef },
  });
  assert.equal(direct.isError, undefined);
  const directText = String(structuredContent(direct).result ?? "");
  assert.match(directText, /Derived recovery cache — not authoritative/);
  assert.match(directText, /Keep Goal DB and Git\/filesystem authoritative/);
  assert.match(directText, /Need to prove fresh Chat hydration stays bounded/);

  const batched = await context.client.callTool({
    name: "workspace_turn",
    arguments: {
      workspace_id: workspaceId,
      max_result_chars: 4_000,
      operations: [{ kind: "read", path: hydrateRef }],
    },
  });
  assert.equal(batched.isError, undefined);
  const step = (structuredContent(batched).steps as Array<Record<string, unknown>>)[0];
  assert.equal(step?.ok, true);
  assert.match(String(step?.result ?? ""), /Goal Recovery Hydration/);
  assert.ok(String(step?.result ?? "").length <= 4_000);
});

test("model-facing tool schemas use snake_case recursively", async (t) => {
  for (const toolMode of ["claude", "codex"] as const) {
    await t.test(toolMode, async (nested) => {
      const context = await fixture(nested, { toolMode, uiEnabled: false });
      const tools = await context.client.listTools();
      const invalidPaths = tools.tools.flatMap((tool) => [
        ...schemaPropertyPaths(tool.inputSchema)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.input.${path}`),
        ...schemaPropertyPaths(tool.outputSchema)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.output.${path}`),
      ]);

      assert.deepEqual(invalidPaths, []);
    });
  }
});

test("Codex process tools accept cached 12-second requests but advertise a four-second effective cap", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const tools = await context.client.listTools();

  for (const toolName of ["exec_command", "write_stdin"] as const) {
    const tool = tools.tools.find(({ name }) => name === toolName);
    const yieldSchema = tool?.inputSchema?.properties?.yield_time_ms as {
      maximum?: number;
      description?: string;
    } | undefined;

    assert.equal(yieldSchema?.maximum, 12_000);
    assert.match(yieldSchema?.description ?? "", /effective synchronous wait is capped at 4000/i);
    if (toolName === "exec_command") {
      assert.match(yieldSchema?.description ?? "", /defaults to 2000/i);
    } else {
      assert.match(yieldSchema?.description ?? "", /polling defaults to 2000/i);
    }
  }
});

test("exec_command detach returns without retaining a process session", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "detached-process"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const node = JSON.stringify(process.execPath);
  const response = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspace_id: workspaceId,
      cmd: `${node} -e "console.log('detached-ready'); setTimeout(() => {}, 800)"`,
      yield_time_ms: 250,
      detach: true,
    },
  });
  const structured = structuredContent(response);

  assert.equal(response.isError, undefined);
  assert.equal(structured.detached, true);
  assert.equal(structured.running, false);
  assert.equal(structured.session_id, undefined);
  assert.match(String(structured.result), /detached-ready/);
  assert.match(String(structured.result), /no DevPilot process session is retained/i);
});

test("standalone Codex process tools clamp cached 12-second waits to four seconds", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "standalone-yield-cap"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const startedAt = performance.now();
  const response = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspace_id: workspaceId,
      cmd: "node -e \"setTimeout(() => {}, 8000)\"",
      yield_time_ms: 12_000,
    },
  });
  const elapsedMs = performance.now() - startedAt;
  const structured = structuredContent(response);
  const sessionId = structured.session_id;

  assert.equal(response.isError, undefined);
  assert.equal(structured.running, true);
  assert.equal(typeof sessionId, "number");
  assert.ok(elapsedMs < 5_000, `exec_command held the MCP call for ${Math.round(elapsedMs)}ms`);

  if (typeof sessionId === "number") {
    await context.client.callTool({
      name: "write_stdin",
      arguments: {
        workspace_id: workspaceId,
        session_id: sessionId,
        chars: "\u0003",
        yield_time_ms: 12_000,
      },
    });
  }
});

test("workspace_turn batches reads and commands in one Codex tool call", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "workspace-turn"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");
  await writeFile(join(context.project, "batch.txt"), "batch-read\n");

  const response = await context.client.callTool({
    name: "workspace_turn",
    arguments: {
      workspace_id: workspaceId,
      operations: [
        { kind: "read", path: "batch.txt" },
        { kind: "exec", cmd: "node -e \"console.log('batch-command')\"" },
      ],
    },
  });

  assert.equal(response.isError, undefined);
  const structured = structuredContent(response);
  assert.equal(structured.completed, 2);
  assert.equal(structured.requested, 2);
  assert.equal(structured.stopped_early, false);
  const steps = structured.steps as Array<Record<string, unknown>>;
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((step) => step.kind), ["read", "exec"]);
  assert.equal(steps.every((step) => step.ok === true), true);
  assert.match(String(steps[0]?.result ?? ""), /batch-read/);
  assert.match(String(steps[1]?.result ?? ""), /batch-command/);
  const rendered = JSON.stringify(response.content);
  assert.match(rendered, /Workspace turn completed 2\/2 operation/);
  assert.doesNotMatch(rendered, /batch-read/);
  assert.doesNotMatch(rendered, /batch-command/);
});

test("workspace_turn keeps long batched commands within a short synchronous wait budget", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "workspace-turn-wait-budget"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const startedAt = performance.now();
  const response = await context.client.callTool({
    name: "workspace_turn",
    arguments: {
      workspace_id: workspaceId,
      operations: [
        { kind: "exec", cmd: "node -e \"setTimeout(() => {}, 5000)\"" },
        { kind: "exec", cmd: "node -e \"setTimeout(() => {}, 5000)\"" },
        { kind: "exec", cmd: "node -e \"setTimeout(() => {}, 5000)\"" },
      ],
    },
  });
  const elapsedMs = performance.now() - startedAt;
  const structured = structuredContent(response);
  const steps = structured.steps as Array<Record<string, unknown>>;
  const sessionIds = steps
    .map((step) => step.session_id)
    .filter((value): value is number => typeof value === "number");
  for (const sessionId of sessionIds) {
    await context.client.callTool({
      name: "write_stdin",
      arguments: {
        workspace_id: workspaceId,
        session_id: sessionId,
        chars: "\u0003",
        yield_time_ms: 1_000,
      },
    });
  }

  assert.equal(response.isError, undefined);
  assert.equal(steps.length, 3);
  assert.equal(steps.every((step) => step.running === true), true);
  assert.equal(steps.every((step) => typeof step.session_id === "number"), true);
  assert.ok(elapsedMs < 4_000, `workspace_turn held the MCP call for ${Math.round(elapsedMs)}ms`);
});

test("workspace_turn resolves the only workspace bound to the current Chat", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "workspace-turn-auto"),
  );
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");
  await writeFile(join(context.project, "auto.txt"), "auto-workspace\n");

  const response = await context.client.callTool({
    name: "workspace_turn",
    arguments: {
      operations: [{ kind: "read", path: "auto.txt" }],
    },
    _meta: { "openai/session": "workspace-turn-auto" },
  } as Parameters<Client["callTool"]>[0]);

  assert.equal(response.isError, undefined);
  const structured = structuredContent(response);
  assert.equal(structured.workspace_id, workspaceId);
  assert.match(String((structured.steps as Array<Record<string, unknown>>)[0]?.result), /auto-workspace/);
});

test("an active Goal resolves workspace_turn even when the Chat has multiple workspace bindings", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const conversationScopeId = "workspace-turn-goal-auto";
  const first = structuredContent(
    await callOpen(context.client, context.project, conversationScopeId),
  );
  const firstWorkspaceId = first.workspace_id;
  assert.equal(typeof firstWorkspaceId, "string");

  const otherProject = join(context.project, "..", "other-project");
  await mkdir(otherProject);
  await writeFile(join(otherProject, "AGENTS.md"), "other project instructions\n");
  const second = structuredContent(await callOpen(context.client, otherProject, conversationScopeId));
  assert.notEqual(second.workspace_id, firstWorkspaceId);

  await callGoal(context.client, {
    action: "start",
    workspace_id: firstWorkspaceId,
    objective: "Keep workspace_turn on the Goal workspace.",
    criteria: [{ id: "done", description: "Resolver test completes." }],
  }, conversationScopeId);
  await writeFile(join(context.project, "goal-auto.txt"), "goal-workspace\n");

  const response = await context.client.callTool({
    name: "workspace_turn",
    arguments: {
      operations: [{ kind: "read", path: "goal-auto.txt" }],
    },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);

  assert.equal(response.isError, undefined);
  const structured = structuredContent(response);
  assert.equal(structured.workspace_id, firstWorkspaceId);
  assert.match(String((structured.steps as Array<Record<string, unknown>>)[0]?.result), /goal-workspace/);
});

test("workspace_turn fairly bounds aggregate model-readable result context", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "workspace-turn-budget"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");
  const largeA = Array.from({ length: 500 }, (_, index) => `A${index.toString().padStart(4, "0")}-${"a".repeat(48)}`).join("\n");
  const largeB = Array.from({ length: 500 }, (_, index) => `B${index.toString().padStart(4, "0")}-${"b".repeat(48)}`).join("\n");
  await writeFile(join(context.project, "large-a.txt"), `${largeA}\n`);
  await writeFile(join(context.project, "large-b.txt"), `${largeB}\n`);

  const response = await context.client.callTool({
    name: "workspace_turn",
    arguments: {
      workspace_id: workspaceId,
      max_result_chars: 4_000,
      operations: [
        { kind: "read", path: "large-a.txt", limit: 500 },
        { kind: "read", path: "large-b.txt", limit: 500 },
      ],
    },
  });
  const structured = structuredContent(response);
  assert.equal(structured.result_char_budget, 4_000);
  assert.equal(structured.result_chars, 4_000);
  assert.equal(structured.truncated_results, 2);
  const steps = structured.steps as Array<Record<string, unknown>>;
  assert.equal(steps.length, 2);
  assert.equal(steps.every((step) => step.result_truncated === true), true);
  assert.equal(steps.every((step) => String(step.result ?? "").length === 2_000), true);
  assert.match(String(steps[0]?.result ?? ""), /result truncated to the turn context budget/);
  assert.match(String(steps[1]?.result ?? ""), /result truncated to the turn context budget/);
});

test("workspace_turn checkpoints resume task state and report bounded workspace deltas", async (t) => {
  const context = await fixture(t, { git: true, toolMode: "codex", uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "workspace-task-resume"),
  );
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const checkpointResponse = await context.client.callTool({
    name: "workspace_turn",
    arguments: {
      workspace_id: workspaceId,
      operations: [{
        kind: "checkpoint",
        status: "active",
        summary: "Implemented task checkpoint persistence.",
        next_step: "Validate workspace delta behavior.",
      }],
    },
  });
  const checkpoint = (structuredContent(checkpointResponse).steps as Array<Record<string, unknown>>)[0];
  assert.equal(checkpoint?.ok, true);
  assert.equal(checkpoint?.checkpoint_status, "active");

  await writeFile(join(context.project, "README.md"), "hello\nchanged after checkpoint\n");
  await writeFile(join(context.project, "later.txt"), "later\n");
  const deltaResponse = await context.client.callTool({
    name: "workspace_turn",
    arguments: {
      workspace_id: workspaceId,
      operations: [{ kind: "delta", max_files: 1 }],
    },
  });
  const delta = (structuredContent(deltaResponse).steps as Array<Record<string, unknown>>)[0];
  assert.equal(delta?.ok, true);
  assert.equal(delta?.changed_file_count, 2);
  assert.equal((delta?.changed_files as string[]).length, 1);
  assert.equal(delta?.omitted_files, 1);
  assert.match(String(delta?.result ?? ""), /Implemented task checkpoint persistence/);
  assert.match(String(delta?.result ?? ""), /Validate workspace delta behavior/);

  const resumed = structuredContent(
    await callOpen(context.client, context.project, "workspace-task-resume"),
  );
  assert.equal(resumed.workspace_id, workspaceId);
  const resume = resumed.resume as Record<string, unknown>;
  assert.equal(resume.status, "active");
  assert.equal(resume.summary, "Implemented task checkpoint persistence.");
  assert.equal(resume.next_step, "Validate workspace delta behavior.");
  assert.match(String(resumed.instruction), /Resume checkpoint/);
  assert.match(String(resumed.instruction), /workspace_turn delta/);
});

test("Claude edit and bash tools accept snake_case runtime inputs", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "snake-case-claude"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "note.txt"), "before\n");
  await mkdir(join(context.project, "nested"));

  const edited = await context.client.callTool({
    name: "edit",
    arguments: {
      workspace_id: workspaceId,
      path: "note.txt",
      edits: [{ old_text: "before", new_text: "after" }],
    },
  });
  assert.equal(edited.isError, undefined);
  assert.equal(await readFile(join(context.project, "note.txt"), "utf8"), "after\n");

  const shell = structuredContent(await context.client.callTool({
    name: "bash",
    arguments: {
      workspace_id: workspaceId,
      command: "pwd",
      working_directory: "nested",
    },
  }));
  assert.match(shell.result as string, /nested/i);
});

test("UI metadata is limited to workspace and aggregate review", async (t) => {
  for (const uiEnabled of [true, false]) {
    await t.test(uiEnabled ? "enabled" : "disabled", async (nested) => {
      const context = await fixture(nested, { toolMode: "claude", uiEnabled });
      const tools = await context.client.listTools();
      const toolsWithUi = tools.tools
        .filter((tool) => Boolean((tool._meta as { ui?: unknown } | undefined)?.ui))
        .map((tool) => tool.name)
        .sort();

      assert.deepEqual(toolsWithUi, uiEnabled ? ["open_workspace", "show_changes"] : []);
    });
  }
});

test("open_workspace reports aggregate review availability", async (t) => {
  const plain = await fixture(t);
  const gitWorkspace = await fixture(t, { git: true });

  const plainReview = structuredContent(await callOpen(plain.client, plain.project, "plain")).review;
  const gitReview = structuredContent(await callOpen(gitWorkspace.client, gitWorkspace.project, "git")).review;

  assert.equal((plainReview as { available: boolean }).available, false);
  assert.deepEqual(gitReview, { available: true });
});

test("show_changes keeps model output compact and preserves the rich review card", async (t) => {
  const context = await fixture(t, { git: true, uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "review"),
  );
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "goodbye\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  const structured = structuredContent(review);
  assert.equal((review._meta as Record<string, unknown> | undefined)?.tool, undefined);

  assert.equal(structured.workspace_id, workspaceId);
  assert.equal("workspaceId" in structured, false);
  assert.match(structured.review_ref as string, /^[0-9a-f]{40,64}$/);
  assert.equal("summary" in structured, false);
  assert.equal("files" in structured, false);
  assert.equal("patch" in structured, false);

  const card = responseCard(review);
  assert.deepEqual(card.summary, {
    files: 1,
    additions: 1,
    removals: 1,
  });
  assert.deepEqual(card.files, [
    {
      path: "README.md",
      type: "change",
      additions: 1,
      removals: 1,
    },
  ]);
  assert.match(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /-hello\n\+goodbye/,
  );

  const tools = await context.client.listTools();
  const outputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.outputSchema?.properties;
  assert.ok(outputProperties && "workspace_id" in outputProperties);
  assert.equal(outputProperties && "workspaceId" in outputProperties, false);
  assert.ok(outputProperties && "review_ref" in outputProperties);
  assert.equal(outputProperties && "summary" in outputProperties, false);
  assert.equal(outputProperties && "files" in outputProperties, false);
  assert.equal(outputProperties && "patch" in outputProperties, false);
  const inputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.inputSchema?.properties;
  assert.equal(inputProperties && "reviewRef" in inputProperties, false);
});

test("show_changes can reopen a historical review without advancing the checkpoint", async (t) => {
  const context = await fixture(t, { git: true });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "review-history"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "first\n");
  const first = structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  }));
  const reviewRef = first.review_ref;
  assert.equal(typeof reviewRef, "string");

  await writeFile(join(context.project, "README.md"), "second\n");
  const reopened = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
    _meta: { "devspace/reviewRef": reviewRef },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(reopened).review_ref, reviewRef);
  assert.match(
    (((responseCard(reopened).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /\+first/,
  );

  const current = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  assert.match(
    (((responseCard(current).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /-first\n\+second/,
  );
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  assert.equal((first._meta as Record<string, unknown> | undefined)?.tool, undefined);
  assert.equal((repeated._meta as Record<string, unknown> | undefined)?.tool, undefined);

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.ok(outputProperties && "workspace_id" in outputProperties);
  assert.equal(outputProperties && "workspaceId" in outputProperties, false);
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  const providerSchema = outputProperties?.agent_providers as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(typeof firstStructured.workspace_id, "string");
  assert.equal("workspaceId" in firstStructured, false);
  assert.equal(firstStructured.workspace_id, structuredContent(repeated).workspace_id);
  assert.ok(Array.isArray(firstStructured.agents_files));
  assert.ok(Array.isArray(firstStructured.available_agents_files));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agent_providers));
  assert.equal(
    (firstStructured.agent_providers as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstStructured.agent_providers as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skill_diagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.match(firstStructured.instruction as string, /workspace_id/);
  assert.match(repeatedStructured.instruction as string, /workspace_id/);
  assert.doesNotMatch(firstStructured.instruction as string, /workspaceId/);
  assert.doesNotMatch(repeatedStructured.instruction as string, /workspaceId/);
  assert.equal(repeatedStructured.agents_files, undefined);
  assert.equal(repeatedStructured.available_agents_files, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agent_providers, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skill_diagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.equal(
    (card.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;
  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(unavailable.agent_providers, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agent_providers as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (usable.agents as Array<Record<string, unknown>>)[0]?.name,
    "reviewer",
  );
});

test("open_workspace omits providers disabled by configuration", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
    subagents: {
      enabled: true,
      instructions: "on-demand",
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agent_providers as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("open_workspace advertises subagent instructions on demand by default", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), true);
  assert.doesNotMatch(String(opened.instruction), /# DevSpace subagents/);
});

test("open_workspace preloads subagent instructions when configured", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    subagents: {
      enabled: true,
      instructions: "preload",
      providers: [{ id: "codex", enabled: true }],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), false);
  assert.match(String(opened.instruction), /# DevSpace subagents/);
});

test("open_workspace scopes checkout reuse to OpenAI session metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  const otherSession = await callOpen(context.client, context.project, "chat-2");
  const unscoped = await callOpen(context.client, context.project);

  assert.equal(structuredContent(repeated).workspace_id, structuredContent(first).workspace_id);
  assert.equal(structuredContent(repeated).agents_files, undefined);
  assert.notEqual(structuredContent(otherSession).workspace_id, structuredContent(first).workspace_id);
  assert.notEqual(structuredContent(unscoped).workspace_id, structuredContent(first).workspace_id);
  assert.ok(Array.isArray(structuredContent(otherSession).agents_files));
  assert.ok(Array.isArray(structuredContent(unscoped).agents_files));
});

test("HTTP endpoint serves modern MCP and stateless legacy clients", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-modern-http-test-",
  );

  const unauthenticated = await postModernMcp(
    localBaseUrl,
    undefined,
    "tools/list",
    {},
  );
  assert.equal(unauthenticated.status, 401, await unauthenticated.clone().text());

  const discovery = await postModernMcp(
    localBaseUrl,
    accessToken,
    "server/discover",
    {},
  );
  assert.equal(discovery.status, 200, await discovery.clone().text());
  const discoveryBody = await discovery.json() as {
    result?: { supportedVersions?: string[] };
  };
  assert.ok(discoveryBody.result?.supportedVersions?.includes("2026-07-28"));

  const listed = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/list",
    {},
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  const listBody = await listed.json() as {
    result?: { tools?: Array<{ name?: string }> };
  };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "open_workspace"));

  const called = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await called.json() as {
    result?: { structuredContent?: { workspace_id?: string; agents_files?: unknown[] } };
  };
  const workspaceId = callBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const repeated = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(repeated.status, 200, await repeated.clone().text());
  const repeatedBody = await repeated.json() as {
    result?: { structuredContent?: { workspace_id?: string; agents_files?: unknown[] } };
  };
  assert.equal(repeatedBody.result?.structuredContent?.workspace_id, workspaceId);
  assert.equal(repeatedBody.result?.structuredContent?.agents_files, undefined);

  const legacy = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "devspace-legacy-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(legacy.status, 200, await legacy.clone().text());
  assert.equal(legacy.headers.get("mcp-session-id"), null);
  assert.match(await legacy.text(), /"protocolVersion"/);

  const legacyTools = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-tools-list",
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(legacyTools.status, 200, await legacyTools.clone().text());
  assert.equal(legacyTools.headers.get("mcp-session-id"), null);
  assert.match(await legacyTools.text(), /"open_workspace"/);
});

test("server shutdown waits for an active MCP tool call", async (t) => {
  const { root, localBaseUrl, accessToken, running } = await httpServerFixture(
    t,
    "devspace-shutdown-test-",
  );
  const opened = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "shutdown-test" },
    },
  );
  const openBody = await opened.json() as {
    result?: { structuredContent?: { workspace_id?: string } };
  };
  const workspaceId = openBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const command = [
    "const fs=require('node:fs')",
    "fs.writeFileSync('started','')",
    "const timer=setInterval(()=>{if(fs.existsSync('release')) clearInterval(timer)},10)",
  ].join(";");
  const toolCall = postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "exec_command",
      arguments: {
        workspace_id: workspaceId,
        cmd: `node -e \"${command}\"`,
        yield_time_ms: 4_000,
      },
    },
  );
  await waitForFile(join(root, "started"));

  let shutdownFinished = false;
  const shutdown = running.close().then(() => {
    shutdownFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shutdownFinished, false);

  await writeFile(join(root, "release"), "");
  await toolCall;
  await shutdown;
  assert.equal(shutdownFinished, true);
});

interface ServerFixture {
  client: Client;
  project: string;
}

function schemaPropertyPaths(
  schema: unknown,
  prefix = "",
): Array<{ key: string; path: string }> {
  if (!schema || typeof schema !== "object") return [];
  const record = schema as {
    properties?: Record<string, unknown>;
    items?: unknown;
    anyOf?: unknown[];
    oneOf?: unknown[];
    allOf?: unknown[];
  };
  const paths = Object.entries(record.properties ?? {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [{ key, path }, ...schemaPropertyPaths(child, path)];
  });
  if (record.items) paths.push(...schemaPropertyPaths(record.items, `${prefix}[]`));
  for (const variant of [record.anyOf, record.oneOf, record.allOf]) {
    for (const child of variant ?? []) {
      paths.push(...schemaPropertyPaths(child, prefix));
    }
  }
  return paths;
}

interface HttpServerFixture {
  root: string;
  localBaseUrl: string;
  accessToken: string;
  running: ReturnType<typeof createServer>;
}

async function httpServerFixture(
  t: TestContext,
  prefix: string,
): Promise<HttpServerFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const ownerToken = "test-owner-token-that-is-long-enough";
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: {
      port: 1,
      publicBaseUrl: "https://example.test",
    },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, ".worktrees"),
    },
    storage: { stateDir: join(root, ".state") },
  }));
  const running = createServer(config, { incomingArtifactAdapters: [] });
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const localBaseUrl = `http://127.0.0.1:${address.port}`;
  const accessToken = await issueTestAccessToken(
    localBaseUrl,
    config.publicBaseUrl,
    ownerToken,
  );
  return { root, localBaseUrl, accessToken, running };
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    toolMode?: ToolMode;
    uiEnabled?: boolean;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const initialProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];
  const loadedConfig = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    skills: { agentDir },
    subagents: {
      enabled: options.localAgentProviders !== undefined,
      instructions: "on-demand",
      providers: [],
    },
  }));
  const modeConfig: ServerConfig = {
    ...loadedConfig,
    toolMode: options.toolMode ?? loadedConfig.toolMode,
    uiEnabled: options.uiEnabled ?? loadedConfig.uiEnabled,
  };
  const config: ServerConfig = options.localAgentProviders
    ? {
        ...modeConfig,
        subagents: options.subagents ?? {
          enabled: true,
          instructions: "on-demand",
          providers: initialProviderAvailability.map((provider) => ({
            id: provider.name,
            enabled: true,
          })),
        },
      }
    : modeConfig;
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
      ? options.localAgentProviders
      : () => initialProviderAvailability;
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );
  const store = new SqliteWorkspaceStore(stateDir);
  const goalStore = new GoalStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    goalStore,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    goalStore.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`Timed out waiting for ${path}`);
}

async function issueTestAccessToken(
  localBaseUrl: string,
  publicBaseUrl: string,
  ownerToken: string,
): Promise<string> {
  const redirectUri = "http://127.0.0.1/callback";
  const resource = new URL("/mcp", publicBaseUrl).href;
  const verifier = "devspace-modern-protocol-test-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetch(`${localBaseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "DevSpace modern protocol test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json() as { client_id?: string };
  assert.ok(client.client_id);

  const approval = await fetch(`${localBaseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "devspace",
      resource,
      state: "modern-test",
      owner_token: ownerToken,
    }),
    redirect: "manual",
  });
  assert.equal(approval.status, 302, await approval.clone().text());
  const location = approval.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);

  const exchange = await fetch(`${localBaseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = await exchange.json() as { access_token?: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}

function postModernMcp(
  localBaseUrl: string,
  accessToken: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  const mcpName = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string"
      ? params.uri
      : undefined;
  return fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(mcpName ? { "mcp-name": mcpName } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          ...recordValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "devspace-modern-http-test",
            version: "1.0.0",
          },
        },
      },
    }),
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: { path },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

async function callGoal(
  client: Client,
  argumentsValue: Record<string, unknown>,
  conversationScopeId?: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "goal",
    arguments: argumentsValue,
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
