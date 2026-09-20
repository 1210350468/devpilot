import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GoalNotCompleteError, GoalStore } from "./goal-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("persistent goal survives restart and attaches a new conversation to the same workspace", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: "ws_goal", root: "/tmp/goal", mode: "checkout" });

  const firstStore = new GoalStore(stateDir);
  const goal = firstStore.createGoal({
    workspaceSessionId: "ws_goal",
    objective: "Finish the persistent goal runtime.",
    criteria: [
      { id: "tests", description: "Focused tests pass." },
      { id: "docs", description: "Documentation is aligned." },
    ],
    constraints: ["Do not touch production."],
    conversationScopeId: "chat-a",
    nextStep: "Implement the goal MCP tool.",
  });
  assert.equal(goal.status, "running");
  assert.equal(firstStore.getGoalForConversation("chat-a")?.id, goal.id);
  firstStore.close();

  const restored = new GoalStore(stateDir);
  t.after(async () => {
    restored.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  assert.equal(restored.requireGoal(goal.id).workspaceSessionId, "ws_goal");
  restored.attachConversation(goal.id, "chat-b");
  assert.equal(restored.getGoalForConversation("chat-b")?.id, goal.id);
  assert.equal(restored.requireGoal(goal.id).constraints[0], "Do not touch production.");
  assert.deepEqual(
    restored.listEvents(goal.id).map((event) => event.kind),
    ["goal_started", "conversation_attached"],
  );
});

test("goal cannot finish until every required criterion has verified evidence", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: "ws_verify", root: "/tmp/verify", mode: "checkout" });
  const store = new GoalStore(stateDir);
  t.after(async () => {
    store.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const goal = store.createGoal({
    workspaceSessionId: "ws_verify",
    objective: "Verify completion gates.",
    criteria: [
      { id: "required", description: "Required check passes." },
      { id: "optional", description: "Optional check.", required: false },
    ],
  });

  assert.throws(
    () => store.finishGoal(goal.id),
    (error) => error instanceof GoalNotCompleteError
      && error.remainingCriteria.map((criterion) => criterion.id).join(",") === "required",
  );

  store.verifyCriteria(goal.id, [{ id: "required", status: "pending" }]);
  assert.throws(
    () => store.finishGoal(goal.id),
    (error) => error instanceof GoalNotCompleteError
      && error.remainingCriteria.map((criterion) => criterion.id).join(",") === "required",
  );

  const verified = store.verifyCriteria(goal.id, [{
    id: "required",
    status: "passed",
    evidence: [{ kind: "test", summary: "Focused suite passed.", ref: "run-1" }],
    verificationSource: "pnpm test",
  }]);
  assert.equal(verified.status, "verifying");
  assert.equal(verified.criteria.find((criterion) => criterion.id === "required")?.evidence[0]?.ref, "run-1");

  const finished = store.finishGoal(goal.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(store.finishGoal(goal.id).status, "succeeded");
});

test("criterion updates preserve prior evidence when evidence is omitted", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: "ws_evidence", root: "/tmp/evidence", mode: "checkout" });
  const store = new GoalStore(stateDir);
  t.after(async () => {
    store.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const goal = store.createGoal({
    workspaceSessionId: "ws_evidence",
    objective: "Preserve evidence.",
    criteria: [{ id: "test", description: "Test passes." }],
  });
  store.verifyCriteria(goal.id, [{
    id: "test",
    status: "failed",
    evidence: [{ kind: "test", summary: "First run failed.", ref: "run-1" }],
    verificationSource: "first-run",
  }]);
  const second = store.verifyCriteria(goal.id, [{ id: "test", status: "pending" }]);
  const criterion = second.criteria[0];
  assert.equal(criterion?.evidence[0]?.ref, "run-1");
  assert.equal(criterion?.verificationSource, "first-run");
});

test("goal status transitions fail closed", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: "ws_state", root: "/tmp/state", mode: "checkout" });
  const store = new GoalStore(stateDir);
  t.after(async () => {
    store.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    workspaceSessionId: "ws_state",
    objective: "Exercise state transitions.",
    criteria: [{ id: "done", description: "Done." }],
  });
  const paused = store.updateGoal({ goalId: goal.id, status: "paused", eventKind: "goal_paused" });
  assert.equal(paused.status, "paused");
  assert.throws(() => store.updateGoal({ goalId: goal.id, status: "succeeded" }), /Invalid goal status transition/);
  assert.equal(store.updateGoal({ goalId: goal.id, status: "running", eventKind: "goal_resumed" }).status, "running");
});
