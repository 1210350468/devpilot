import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GoalStore, type GoalBrowserBinding, type PersistentGoal } from "./goal-store.js";
import {
  GoalContinuationWatchdog,
  type GoalBrowserAdapter,
  type GoalBrowserSendResult,
  type GoalBrowserSnapshot,
} from "./goal-watchdog.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

class FakeBrowser implements GoalBrowserAdapter {
  readonly id = "fake-browser";
  snapshot: GoalBrowserSnapshot = {
    state: "idle",
    conversationUrl: "https://chatgpt.com/c/chat-a",
    conversationKey: "chat-a",
  };
  continues: Array<{ prompt: string; roundNumber: number; resumeNonce: string }> = [];
  rotations: Array<{ prompt: string; roundNumber: number; resumeNonce: string }> = [];

  async inspect(_input: { goal: PersistentGoal; binding?: GoalBrowserBinding }): Promise<GoalBrowserSnapshot> {
    return this.snapshot;
  }

  async sendContinuation(input: {
    prompt: string;
    roundNumber: number;
    resumeNonce: string;
  }): Promise<GoalBrowserSendResult> {
    this.continues.push(input);
    return {
      conversationUrl: this.snapshot.conversationUrl,
      conversationKey: this.snapshot.conversationKey,
    };
  }

  async rotateConversation(input: {
    prompt: string;
    roundNumber: number;
    resumeNonce: string;
  }): Promise<GoalBrowserSendResult> {
    this.rotations.push(input);
    this.snapshot = {
      state: "generating",
      conversationUrl: "https://chatgpt.com/c/chat-b",
      conversationKey: "chat-b",
    };
    return {
      conversationUrl: this.snapshot.conversationUrl,
      conversationKey: this.snapshot.conversationKey,
    };
  }
}

test("watchdog sends one continuation, waits for acknowledgement, then advances the next round", async (t) => {
  const context = await fixture(t, "ws_watchdog");
  const goal = context.goalStore.createGoal({
    workspaceSessionId: context.workspaceId,
    objective: "Continue automatically.",
    criteria: [{ id: "done", description: "Finish the task." }],
  });
  const browser = new FakeBrowser();
  let now = new Date("2026-09-20T00:00:00.000Z");
  const watchdog = new GoalContinuationWatchdog(context.goalStore, browser, {
    ownerId: "watchdog-a",
    leaseMs: 60_000,
    now: () => now,
  });

  const first = await watchdog.tickGoal(goal);
  assert.equal(first.kind, "sent_continue");
  assert.equal(browser.continues.length, 1);
  assert.match(browser.continues[0]?.prompt ?? "", /GOAL_CONTINUE/);
  assert.match(browser.continues[0]?.prompt ?? "", /resume_nonce=/);

  const pending = await watchdog.tickGoal(context.goalStore.requireGoal(goal.id));
  assert.equal(pending.kind, "pending_ack");
  assert.equal(browser.continues.length, 1);

  const active = context.goalStore.requireGoal(goal.id);
  assert.ok(active.lastResumeNonce);
  context.goalStore.acknowledgeContinuation({
    goalId: goal.id,
    nonce: active.lastResumeNonce,
    conversationScopeId: "chat-a-session",
    now: new Date(now.getTime() + 1_000),
  });
  now = new Date(now.getTime() + 2_000);

  const second = await watchdog.tickGoal(context.goalStore.requireGoal(goal.id));
  assert.equal(second.kind, "sent_continue");
  assert.equal(browser.continues.length, 2);
  assert.equal(browser.continues[1]?.roundNumber, 2);
});

test("watchdog rotates conversation when the current Chat reaches its limit", async (t) => {
  const context = await fixture(t, "ws_rotation");
  const goal = context.goalStore.createGoal({
    workspaceSessionId: context.workspaceId,
    objective: "Rotate ChatGPT conversations.",
    criteria: [{ id: "done", description: "Finish the task." }],
  });
  const browser = new FakeBrowser();
  browser.snapshot = {
    state: "conversation_limit",
    conversationUrl: "https://chatgpt.com/c/chat-full",
    conversationKey: "chat-full",
  };
  const watchdog = new GoalContinuationWatchdog(context.goalStore, browser, {
    ownerId: "watchdog-rotation",
    now: () => new Date("2026-09-20T00:00:00.000Z"),
  });

  const outcome = await watchdog.tickGoal(goal);
  assert.equal(outcome.kind, "sent_resume");
  assert.equal(browser.rotations.length, 1);
  assert.match(browser.rotations[0]?.prompt ?? "", /GOAL_RESUME/);
  assert.match(browser.rotations[0]?.prompt ?? "", /action=attach/);
  const binding = context.goalStore.getBrowserBinding(goal.id);
  assert.equal(binding?.conversationUrl, "https://chatgpt.com/c/chat-b");
  assert.equal(binding?.rotationCount, 1);
});

test("two watchdog owners cannot send the same Goal round concurrently", async (t) => {
  const context = await fixture(t, "ws_race");
  const secondStore = new GoalStore(context.stateDir);
  const goal = context.goalStore.createGoal({
    workspaceSessionId: context.workspaceId,
    objective: "Prevent duplicate browser sends.",
    criteria: [{ id: "done", description: "Finish the task." }],
  });
  const browserA = new FakeBrowser();
  const browserB = new FakeBrowser();
  const now = () => new Date("2026-09-20T00:00:00.000Z");
  const watchdogA = new GoalContinuationWatchdog(context.goalStore, browserA, { ownerId: "watchdog-a", now });
  const watchdogB = new GoalContinuationWatchdog(secondStore, browserB, { ownerId: "watchdog-b", now });

  const outcomes = await Promise.all([
    watchdogA.tickGoal(goal),
    watchdogB.tickGoal(goal),
  ]);
  secondStore.close();
  assert.equal(outcomes.filter((outcome) => outcome.kind === "sent_continue").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.kind === "busy").length, 1);
  assert.equal(browserA.continues.length + browserB.continues.length, 1);
});

test("watchdog crash recovery reuses the same round and resume nonce after lease expiry", async (t) => {
  const context = await fixture(t, "ws_crash_retry");
  const goal = context.goalStore.createGoal({
    workspaceSessionId: context.workspaceId,
    objective: "Recover an unacknowledged browser send.",
    criteria: [{ id: "done", description: "Finish the task." }],
  });
  const browserA = new FakeBrowser();
  let now = new Date("2026-09-20T00:00:00.000Z");
  const watchdogA = new GoalContinuationWatchdog(context.goalStore, browserA, {
    ownerId: "watchdog-a",
    leaseMs: 5_000,
    now: () => now,
  });
  const first = await watchdogA.tickGoal(goal);
  assert.equal(first.kind, "sent_continue");
  if (first.kind !== "sent_continue") throw new Error("Expected initial continuation send.");

  now = new Date(now.getTime() + 6_000);
  const browserB = new FakeBrowser();
  const watchdogB = new GoalContinuationWatchdog(context.goalStore, browserB, {
    ownerId: "watchdog-b",
    leaseMs: 5_000,
    now: () => now,
  });
  const retried = await watchdogB.tickGoal(context.goalStore.requireGoal(goal.id));
  assert.equal(retried.kind, "sent_continue");
  if (retried.kind !== "sent_continue") throw new Error("Expected continuation retry.");
  assert.equal(retried.roundNumber, first.roundNumber);
  assert.equal(retried.resumeNonce, first.resumeNonce);
  assert.equal(context.goalStore.requireGoal(goal.id).roundNumber, 1);
});

test("watchdog does not claim a round while ChatGPT is generating or unavailable", async (t) => {
  const context = await fixture(t, "ws_browser_state");
  const goal = context.goalStore.createGoal({
    workspaceSessionId: context.workspaceId,
    objective: "Respect browser state.",
    criteria: [{ id: "done", description: "Finish the task." }],
  });
  const browser = new FakeBrowser();
  const watchdog = new GoalContinuationWatchdog(context.goalStore, browser, { ownerId: "watchdog-state" });

  browser.snapshot = { state: "generating" };
  assert.equal((await watchdog.tickGoal(goal)).kind, "generating");
  assert.equal(context.goalStore.requireGoal(goal.id).roundNumber, 0);

  browser.snapshot = { state: "login_required", detail: "Login page visible." };
  const unavailable = await watchdog.tickGoal(goal);
  assert.equal(unavailable.kind, "browser_unavailable");
  assert.equal(context.goalStore.requireGoal(goal.id).roundNumber, 0);
});

async function fixture(t: test.TestContext, workspaceId: string) {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-watchdog-test-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({ id: workspaceId, root: `/tmp/${workspaceId}`, mode: "checkout" });
  const goalStore = new GoalStore(stateDir);
  t.after(async () => {
    goalStore.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  return { stateDir, workspaceId, goalStore };
}
