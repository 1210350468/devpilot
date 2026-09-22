import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GoalContextStore,
  chooseHydrationProfile,
  goalContextRefs,
  resolveGoalContextReadPath,
} from "./goal-context.js";
import type { GoalEvent, PersistentGoal } from "./goal-store.js";

test("Goal context store writes bounded derived Markdown recovery files", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-context-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const goal = fixtureGoal();
  const store = new GoalContextStore(stateDir);
  const snapshot = await store.refresh(goal, fixtureEvents());

  assert.equal(snapshot.profile, "verification");
  assert.equal(snapshot.hydrateRef, `@context/${goal.id}/hydrate.md`);
  const readPath = resolveGoalContextReadPath(stateDir, goal.workspaceSessionId, snapshot.hydrateRef);
  assert.ok(readPath);
  const hydrate = await readFile(readPath.absolutePath, "utf8");
  assert.ok(hydrate.length <= 12_000);
  assert.match(hydrate, /Derived recovery cache — not authoritative/);
  assert.match(hydrate, /Do not touch production/);
  assert.match(hydrate, /Run release verification/);
  assert.match(hydrate, /Focused suite passed/);
  assert.doesNotMatch(hydrate, /raw-user-turn-that-must-never-be-copied/i);

  const manifestPath = resolveGoalContextReadPath(stateDir, goal.workspaceSessionId, snapshot.manifestRef);
  assert.ok(manifestPath);
  const manifest = await readFile(manifestPath.absolutePath, "utf8");
  assert.match(manifest, new RegExp(escapeRegExp(snapshot.hydrateRef)));
  assert.match(manifest, new RegExp(escapeRegExp(goalContextRefs(goal.id).history)));
});

test("Goal recovery paths are allowlisted and traversal fails closed", () => {
  const stateDir = "/tmp/state";
  const workspaceId = "ws_abc";
  assert.equal(resolveGoalContextReadPath(stateDir, workspaceId, "README.md"), undefined);
  assert.throws(
    () => resolveGoalContextReadPath(stateDir, workspaceId, "@context/goal_abc/../hydrate.md"),
    /must use @context/,
  );
  assert.throws(
    () => resolveGoalContextReadPath(stateDir, workspaceId, "@context/goal_abc/secret.txt"),
    /Unsupported Goal recovery context file/,
  );
});

test("hydration profile favors verification and debugging context deterministically", () => {
  const goal = fixtureGoal();
  assert.equal(chooseHydrationProfile(goal), "verification");
  assert.equal(chooseHydrationProfile({
    ...goal,
    status: "running",
    summary: "Investigate duplicate watchdog bug.",
    currentStep: "Debug crash recovery.",
    nextStep: undefined,
    resumeCapsule: { failures: ["Old retry loop duplicated sends."] },
  }), "debug");
  assert.equal(chooseHydrationProfile({
    ...goal,
    status: "running",
    summary: "Continue implementation.",
    currentStep: undefined,
    nextStep: undefined,
    resumeCapsule: {},
  }), "minimal");
});

test("refresh replaces stale derived state when the authoritative Goal changes", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-context-refresh-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new GoalContextStore(stateDir);
  const firstGoal = fixtureGoal();
  const first = await store.refresh(firstGoal, fixtureEvents());
  const readPath = resolveGoalContextReadPath(stateDir, firstGoal.workspaceSessionId, first.hydrateRef);
  assert.ok(readPath);
  assert.match(await readFile(readPath.absolutePath, "utf8"), /Need release verification before completion/);

  const secondGoal: PersistentGoal = {
    ...firstGoal,
    summary: "Verification finished; prepare the next milestone.",
    currentStep: "Prepare the next milestone.",
    updatedAt: "2026-09-21T02:00:00.000Z",
    resumeCapsule: {
      ...firstGoal.resumeCapsule,
      currentProblem: "No active verification blocker remains.",
      nextActions: ["Start the next milestone."],
    },
  };
  await store.refresh(secondGoal, [{
    id: 2,
    goalId: firstGoal.id,
    kind: "checkpoint",
    roundNumber: 5,
    payload: { note: "Verification finished." },
    createdAt: "2026-09-21T02:00:00.000Z",
  }]);
  const refreshed = await readFile(readPath.absolutePath, "utf8");
  assert.match(refreshed, /No active verification blocker remains/);
  assert.match(refreshed, /Start the next milestone/);
  assert.doesNotMatch(refreshed, /Need release verification before completion/);
});

test("hydrate remains capped when a Goal has many large required criteria", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-context-budget-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const goal: PersistentGoal = {
    ...fixtureGoal(),
    status: "running",
    summary: "Continue implementation.",
    currentStep: undefined,
    nextStep: undefined,
    resumeCapsule: {},
    criteria: Array.from({ length: 50 }, (_, index) => ({
      id: `criterion_${index}`,
      description: `${index}-${"x".repeat(600)}`,
      required: true,
      status: "pending" as const,
      evidence: [],
      updatedAt: "2026-09-21T01:00:00.000Z",
    })),
  };
  const store = new GoalContextStore(stateDir);
  const snapshot = await store.refresh(goal, []);
  const readPath = resolveGoalContextReadPath(stateDir, goal.workspaceSessionId, snapshot.hydrateRef);
  assert.ok(readPath);
  const hydrate = await readFile(readPath.absolutePath, "utf8");
  assert.ok(hydrate.length <= 12_000);
  assert.match(hydrate, /truncated to its bounded context budget/);
});

test("project Markdown hydration indexes paths and headings without copying source bodies", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-context-project-state-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "devspace-goal-context-project-root-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  await mkdir(join(workspaceRoot, "docs"), { recursive: true });
  await writeFile(join(workspaceRoot, "docs", "persistent-context.md"), [
    "# Persistent Context",
    "body-sentinel-that-must-not-be-copied",
    "## Adaptive Hydration",
    "More body text.",
    "## Rotation Pressure",
  ].join("\n"));
  await writeFile(join(workspaceRoot, "docs", "unrelated.md"), "# Cooking Notes\nNothing relevant.\n");

  const goal: PersistentGoal = {
    ...fixtureGoal(),
    objective: "Improve persistent context adaptive hydration and rotation pressure.",
    summary: "Index project Markdown for adaptive hydration.",
  };
  const store = new GoalContextStore(stateDir);
  const snapshot = await store.refresh(goal, fixtureEvents(), { workspaceRoot });
  const refs = goalContextRefs(goal.id);
  const projectIndexPath = resolveGoalContextReadPath(stateDir, goal.workspaceSessionId, refs.projectDocs);
  assert.ok(projectIndexPath);
  const projectIndex = await readFile(projectIndexPath.absolutePath, "utf8");
  assert.match(projectIndex, /docs\/persistent-context\.md/);
  assert.match(projectIndex, /L1 # Persistent Context/);
  assert.match(projectIndex, /L3 ## Adaptive Hydration/);
  assert.doesNotMatch(projectIndex, /body-sentinel-that-must-not-be-copied/);

  const hydratePath = resolveGoalContextReadPath(stateDir, goal.workspaceSessionId, snapshot.hydrateRef);
  assert.ok(hydratePath);
  const hydrate = await readFile(hydratePath.absolutePath, "utf8");
  assert.match(hydrate, /Project Markdown leads/);
  assert.match(hydrate, /docs\/persistent-context\.md/);
  assert.doesNotMatch(hydrate, /body-sentinel-that-must-not-be-copied/);
});

test("multi-megabyte Markdown source stays external while hydration remains bounded", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-goal-context-scale-state-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "devspace-goal-context-scale-root-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  await mkdir(join(workspaceRoot, "research"), { recursive: true });
  const body = "x".repeat(550_000);
  for (let index = 0; index < 8; index += 1) {
    const heading = index === 7 ? "# Adaptive Context Million Scale Benchmark" : `# Archive ${index}`;
    await writeFile(join(workspaceRoot, "research", `part-${index}.md`), `${heading}\n${body}\n`);
  }

  const goal: PersistentGoal = {
    ...fixtureGoal(),
    status: "running",
    objective: "Run adaptive context million scale benchmark.",
    summary: "Keep multi-megabyte Markdown external and hydrate only an index.",
    currentStep: "Find the million scale benchmark document.",
    nextStep: undefined,
  };
  const store = new GoalContextStore(stateDir);
  const snapshot = await store.refresh(goal, [], { workspaceRoot });
  const hydratePath = resolveGoalContextReadPath(stateDir, goal.workspaceSessionId, snapshot.hydrateRef);
  const projectIndexPath = resolveGoalContextReadPath(
    stateDir,
    goal.workspaceSessionId,
    goalContextRefs(goal.id).projectDocs,
  );
  assert.ok(hydratePath);
  assert.ok(projectIndexPath);
  const hydrate = await readFile(hydratePath.absolutePath, "utf8");
  const projectIndex = await readFile(projectIndexPath.absolutePath, "utf8");
  assert.ok(hydrate.length <= 12_000);
  assert.ok(projectIndex.length <= 24_000);
  assert.match(hydrate, /research\/part-7\.md/);
  assert.match(projectIndex, /Indexed source bytes: 4[0-9]{6}/);
  assert.ok(!hydrate.includes(body.slice(0, 10_000)));
});

function fixtureGoal(): PersistentGoal {
  return {
    id: "goal_context_test",
    workspaceSessionId: "ws_context_test",
    objective: "Resume a long-running Goal without replaying prior chats.",
    status: "verifying",
    constraints: ["Do not touch production."],
    resumeCapsule: {
      decisions: ["Keep ChatGPT Web as the reasoning agent."],
      currentState: "Context cache implementation is complete.",
      currentProblem: "Need release verification before completion.",
      nextActions: ["Run release verification."],
      failures: ["Do not make Markdown a second truth source."],
      evidence: ["TypeScript passes."],
    },
    summary: "Verify the Persistent Context Store.",
    currentStep: "Run release verification.",
    nextStep: "Run pnpm test.",
    roundNumber: 4,
    budgets: {
      maxRounds: 80,
      maxWallTimeMinutes: 720,
      maxNoProgressRounds: 4,
      maxSameFailure: 3,
    },
    pendingResume: false,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T01:00:00.000Z",
    criteria: [{
      id: "tests",
      description: "Focused suite passes.",
      required: true,
      status: "passed",
      evidence: [{ kind: "test", summary: "Focused suite passed.", ref: "pnpm-test" }],
      verificationSource: "pnpm test",
      verificationTime: "2026-09-21T01:00:00.000Z",
      updatedAt: "2026-09-21T01:00:00.000Z",
    }],
  };
}

function fixtureEvents(): GoalEvent[] {
  return [{
    id: 1,
    goalId: "goal_context_test",
    kind: "checkpoint",
    roundNumber: 4,
    payload: { note: "Ready to verify." },
    createdAt: "2026-09-21T01:00:00.000Z",
  }];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
