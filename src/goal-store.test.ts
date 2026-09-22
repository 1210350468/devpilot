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

test("continuation claims are idempotent, leased, acknowledged, and releasable", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: "ws_continuation", root: "/tmp/continuation", mode: "checkout" });
  const store = new GoalStore(stateDir);
  t.after(async () => {
    store.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    workspaceSessionId: "ws_continuation",
    objective: "Continue across GPT turns.",
    criteria: [{ id: "done", description: "Goal is done." }],
  });
  const now = new Date("2026-09-20T00:00:00.000Z");
  const first = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-a",
    nonce: "resume_nonce_1",
    leaseMs: 60_000,
    now,
  });
  assert.equal(first.kind, "claimed");
  if (first.kind !== "claimed") throw new Error("Expected claimed continuation.");
  assert.equal(first.roundNumber, 1);
  assert.equal(first.idempotent, false);
  assert.equal(first.goal.pendingResume, true);

  const replay = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-a",
    nonce: "resume_nonce_1",
    leaseMs: 60_000,
    now,
  });
  assert.equal(replay.kind, "claimed");
  if (replay.kind !== "claimed") throw new Error("Expected idempotent continuation claim.");
  assert.equal(replay.roundNumber, 1);
  assert.equal(replay.idempotent, true);

  const competing = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-b",
    nonce: "resume_nonce_2",
    leaseMs: 60_000,
    now,
  });
  assert.equal(competing.kind, "busy");

  const acknowledged = store.acknowledgeContinuation({
    goalId: goal.id,
    nonce: "resume_nonce_1",
    conversationScopeId: "chat-resumed",
    now: new Date(now.getTime() + 1_000),
  });
  assert.equal(acknowledged.pendingResume, false);
  assert.equal(acknowledged.leaseOwner, "watchdog-a");
  assert.equal(store.getGoalForConversation("chat-resumed")?.id, goal.id);

  const stillBusy = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-b",
    nonce: "resume_nonce_2",
    leaseMs: 60_000,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(stillBusy.kind, "busy");

  const released = store.releaseContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-a",
    nonce: "resume_nonce_1",
    now: new Date(now.getTime() + 3_000),
  });
  assert.equal(released.leaseOwner, undefined);

  const second = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-b",
    nonce: "resume_nonce_2",
    leaseMs: 60_000,
    now: new Date(now.getTime() + 4_000),
  });
  assert.equal(second.kind, "claimed");
  if (second.kind !== "claimed") throw new Error("Expected second continuation claim.");
  assert.equal(second.roundNumber, 2);
});

test("non-continuable goal states clear an in-flight continuation lease immediately", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: "ws_pause_lease", root: "/tmp/pause-lease", mode: "checkout" });
  const store = new GoalStore(stateDir);
  t.after(async () => {
    store.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    workspaceSessionId: "ws_pause_lease",
    objective: "Stop browser continuation as soon as the Goal pauses.",
    criteria: [{ id: "done", description: "Goal is done." }],
  });
  const claimed = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-a",
    nonce: "pause_nonce_1",
    leaseMs: 60_000,
  });
  assert.equal(claimed.kind, "claimed");

  const paused = store.updateGoal({ goalId: goal.id, status: "paused", eventKind: "goal_paused" });
  assert.equal(paused.pendingResume, false);
  assert.equal(paused.leaseOwner, undefined);
  assert.equal(paused.leaseUntil, undefined);

  const resumed = store.updateGoal({ goalId: goal.id, status: "running", eventKind: "goal_resumed" });
  assert.equal(resumed.status, "running");
  const next = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-b",
    nonce: "pause_nonce_2",
    leaseMs: 60_000,
  });
  assert.equal(next.kind, "claimed");
});

test("expired continuation leases can be taken over and budgets block further rounds", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: "ws_budget", root: "/tmp/budget", mode: "checkout" });
  const store = new GoalStore(stateDir);
  t.after(async () => {
    store.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    workspaceSessionId: "ws_budget",
    objective: "Respect continuation budgets.",
    criteria: [{ id: "done", description: "Goal is done." }],
    budgets: { maxRounds: 2 },
  });
  const now = new Date("2026-09-20T00:00:00.000Z");
  assert.equal(store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-a",
    nonce: "resume_nonce_a",
    leaseMs: 5_000,
    now,
  }).kind, "claimed");

  const takeover = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-b",
    nonce: "resume_nonce_b",
    leaseMs: 5_000,
    now: new Date(now.getTime() + 6_000),
  });
  assert.equal(takeover.kind, "claimed");
  if (takeover.kind !== "claimed") throw new Error("Expected takeover after lease expiry.");
  assert.equal(takeover.roundNumber, 2);
  store.releaseContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-b",
    nonce: "resume_nonce_b",
    now: new Date(now.getTime() + 7_000),
  });

  const exhausted = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog-c",
    nonce: "resume_nonce_c",
    now: new Date(now.getTime() + 8_000),
  });
  assert.equal(exhausted.kind, "budget_exhausted");
  if (exhausted.kind !== "budget_exhausted") throw new Error("Expected budget exhaustion.");
  assert.equal(exhausted.reason, "max_rounds");
  assert.equal(exhausted.goal.status, "blocked");
});

test("no-progress guard blocks repeated unchanged continuation rounds", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: "ws_no_progress", root: "/tmp/no-progress", mode: "checkout" });
  const store = new GoalStore(stateDir);
  t.after(async () => {
    store.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    workspaceSessionId: "ws_no_progress",
    objective: "Stop if repeated continuation rounds make no durable progress.",
    criteria: [{ id: "done", description: "Goal is done." }],
    budgets: { maxNoProgressRounds: 2, maxSameFailure: 99 },
  });
  const start = new Date("2026-09-20T00:00:00.000Z");

  for (let index = 0; index < 2; index += 1) {
    const nonce = `no_progress_${index}`;
    const claimed = store.claimContinuation({
      goalId: goal.id,
      leaseOwner: "watchdog",
      nonce,
      now: new Date(start.getTime() + index * 2_000),
    });
    assert.equal(claimed.kind, "claimed");
    store.releaseContinuation({
      goalId: goal.id,
      leaseOwner: "watchdog",
      nonce,
      now: new Date(start.getTime() + index * 2_000 + 1_000),
    });
  }

  const exhausted = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog",
    nonce: "no_progress_2",
    now: new Date(start.getTime() + 4_000),
  });
  assert.equal(exhausted.kind, "budget_exhausted");
  if (exhausted.kind !== "budget_exhausted") throw new Error("Expected no-progress exhaustion.");
  assert.equal(exhausted.reason, "no_progress");
  assert.equal(exhausted.goal.status, "blocked");
  assert.equal(store.listEvents(goal.id).at(-1)?.payload.reason, "no_progress");
});

test("durable Goal checkpoint progress resets the no-progress guard", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: "ws_progress_reset", root: "/tmp/progress-reset", mode: "checkout" });
  const store = new GoalStore(stateDir);
  t.after(async () => {
    store.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    workspaceSessionId: "ws_progress_reset",
    objective: "Reset the guard when durable state advances.",
    criteria: [{ id: "done", description: "Goal is done." }],
    budgets: { maxNoProgressRounds: 2, maxSameFailure: 99 },
  });
  const start = new Date("2026-09-20T01:00:00.000Z");
  for (let index = 0; index < 2; index += 1) {
    const nonce = `progress_reset_${index}`;
    assert.equal(store.claimContinuation({
      goalId: goal.id,
      leaseOwner: "watchdog",
      nonce,
      now: new Date(start.getTime() + index * 2_000),
    }).kind, "claimed");
    store.releaseContinuation({
      goalId: goal.id,
      leaseOwner: "watchdog",
      nonce,
      now: new Date(start.getTime() + index * 2_000 + 1_000),
    });
  }
  store.updateGoal({
    goalId: goal.id,
    summary: "Implemented the next milestone.",
    currentStep: "Verify the milestone.",
    resumeCapsule: { currentState: "Implementation advanced after the previous round." },
    eventKind: "checkpoint",
  });
  const advanced = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog",
    nonce: "progress_reset_2",
    now: new Date(start.getTime() + 4_000),
  });
  assert.equal(advanced.kind, "claimed");
  assert.equal(store.requireGoal(goal.id).status, "running");
});

test("same-failure guard blocks repeated failure even when other Goal state changes", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-store-test-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: "ws_same_failure", root: "/tmp/same-failure", mode: "checkout" });
  const store = new GoalStore(stateDir);
  t.after(async () => {
    store.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const goal = store.createGoal({
    workspaceSessionId: "ws_same_failure",
    objective: "Stop retrying the same failed strategy forever.",
    criteria: [{ id: "done", description: "Goal is done." }],
    budgets: { maxNoProgressRounds: 99, maxSameFailure: 2 },
  });
  const start = new Date("2026-09-20T02:00:00.000Z");
  const baseline = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog",
    nonce: "same_failure_0",
    now: start,
  });
  assert.equal(baseline.kind, "claimed");
  store.releaseContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog",
    nonce: "same_failure_0",
    now: new Date(start.getTime() + 500),
  });

  store.updateGoal({
    goalId: goal.id,
    summary: "First attempt failed.",
    resumeCapsule: { currentState: "Attempt one finished.", failures: ["network timeout"] },
    eventKind: "checkpoint",
  });
  const firstFailure = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog",
    nonce: "same_failure_1",
    now: new Date(start.getTime() + 1_000),
  });
  assert.equal(firstFailure.kind, "claimed");
  store.releaseContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog",
    nonce: "same_failure_1",
    now: new Date(start.getTime() + 1_500),
  });

  store.updateGoal({
    goalId: goal.id,
    summary: "Second attempt changed diagnostics but hit the same failure.",
    resumeCapsule: { currentState: "Attempt two gathered more diagnostics.", failures: ["network timeout"] },
    eventKind: "checkpoint",
  });
  const repeated = store.claimContinuation({
    goalId: goal.id,
    leaseOwner: "watchdog",
    nonce: "same_failure_2",
    now: new Date(start.getTime() + 2_000),
  });
  assert.equal(repeated.kind, "budget_exhausted");
  if (repeated.kind !== "budget_exhausted") throw new Error("Expected same-failure exhaustion.");
  assert.equal(repeated.reason, "same_failure");
  assert.equal(repeated.goal.status, "blocked");
});
