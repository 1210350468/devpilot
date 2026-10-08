import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GoalStore } from "./goal-store.js";
import {
  GoalWatchdogService,
} from "./goal-watchdog-service.js";
import type {
  GoalBrowserAdapter,
  GoalBrowserSnapshot,
} from "./goal-watchdog.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

class FakeBrowser implements GoalBrowserAdapter {
  readonly id = "fake-browser";
  state: GoalBrowserSnapshot = {
    state: "idle",
    conversationUrl: "https://chatgpt.com/c/test",
    conversationKey: "target-test",
  };
  sends = 0;

  async inspect(): Promise<GoalBrowserSnapshot> {
    return this.state;
  }

  async sendContinuation() {
    this.sends += 1;
    return {
      conversationUrl: "https://chatgpt.com/c/test",
      conversationKey: "target-test",
    };
  }

  async rotateConversation(): Promise<never> {
    throw new Error("not expected");
  }
}

test("goal watchdog service stays disarmed without active Goals and wakes on notification", async (t) => {
  const context = await createContext();
  const browser = new FakeBrowser();
  let factoryCalls = 0;
  const service = new GoalWatchdogService(context.goalStore, {
    intervalMs: 20,
    browserRetryMs: 20,
    browserFactory: () => {
      factoryCalls += 1;
      return browser;
    },
  });
  t.after(async () => {
    await service.stop();
    await context.close();
  });

  service.notify();
  await sleep(50);
  assert.equal(factoryCalls, 0);
  assert.equal(service.snapshot().state, "idle");

  const goal = context.goalStore.createGoal({
    workspaceSessionId: context.workspaceId,
    objective: "Wake only for an active Goal.",
    criteria: [{ id: "done", description: "Done." }],
  });
  service.notify();
  await waitFor(() => browser.sends === 1);
  assert.equal(factoryCalls, 1);
  assert.equal(context.goalStore.requireGoal(goal.id).roundNumber, 1);
  assert.equal(service.snapshot().activeGoals, 1);
});

test("goal watchdog service disarms after an approval gate clears the continuation lease", async (t) => {
  const context = await createContext();
  const browser = new FakeBrowser();
  const service = new GoalWatchdogService(context.goalStore, {
    intervalMs: 20,
    browserRetryMs: 20,
    browserFactory: () => browser,
  });
  t.after(async () => {
    await service.stop();
    await context.close();
  });

  const goal = context.goalStore.createGoal({
    workspaceSessionId: context.workspaceId,
    objective: "Stop automatically at approval.",
    criteria: [{ id: "done", description: "Done." }],
  });
  service.notify();
  await waitFor(() => browser.sends === 1);
  const gated = context.goalStore.updateGoal({
    goalId: goal.id,
    status: "waiting_approval",
    eventKind: "approval_requested",
  });
  assert.equal(gated.pendingResume, false);
  assert.equal(gated.leaseOwner, undefined);
  service.notify();
  await waitFor(() => service.snapshot().state === "idle");
  await sleep(50);
  assert.equal(browser.sends, 1);
});

test("goal watchdog service retries browser discovery only while a Goal remains active", async (t) => {
  const context = await createContext();
  let attempts = 0;
  const service = new GoalWatchdogService(context.goalStore, {
    intervalMs: 20,
    browserRetryMs: 20,
    browserFactory: () => {
      attempts += 1;
      throw new Error("RoxyBrowser is unavailable");
    },
  });
  t.after(async () => {
    await service.stop();
    await context.close();
  });
  const goal = context.goalStore.createGoal({
    workspaceSessionId: context.workspaceId,
    objective: "Wait for browser transport.",
    criteria: [{ id: "done", description: "Done." }],
  });

  service.notify();
  await waitFor(() => attempts >= 1);
  assert.equal(service.snapshot().state, "waiting_browser");
  context.goalStore.updateGoal({ goalId: goal.id, status: "paused", eventKind: "goal_paused" });
  service.notify();
  const attemptsAtPause = attempts;
  await sleep(80);
  assert.equal(attempts, attemptsAtPause);
  assert.equal(service.snapshot().state, "idle");
});

async function createContext() {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-watchdog-service-"));
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const workspaceId = "ws_goal_watchdog_service";
  workspaceStore.createSession({ id: workspaceId, root: "/tmp/watchdog-service", mode: "checkout" });
  const goalStore = new GoalStore(stateDir);
  return {
    stateDir,
    workspaceId,
    goalStore,
    close: async () => {
      goalStore.close();
      workspaceStore.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("Timed out waiting for Goal watchdog service state.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
