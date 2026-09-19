import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Result as BetterResult } from "better-result";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("workspace store lists only stale managed worktrees", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const managed = store.createSession({
    id: "ws_managed",
    root: "/tmp/managed",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: true,
  });
  store.createSession({
    id: "ws_checkout",
    root: "/tmp/repo",
    mode: "checkout",
  });
  store.createSession({
    id: "ws_unmanaged",
    root: "/tmp/unmanaged",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: false,
  });

  assert.deepEqual(
    unwrap(store.listStaleManagedWorktrees(new Date(Date.now() + 60_000))).map((session) => session.id),
    [managed.id],
  );
  assert.deepEqual(unwrap(store.listStaleManagedWorktrees(new Date(0))), []);
});

test("pruned worktree sessions retain recovery state and can be reactivated", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  store.createSession({
    id: "ws_recoverable",
    root: "/tmp/worktree",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: true,
  });

  unwrap(store.markSessionPruned("ws_recoverable", "stash"));
  assert.equal(store.getSession("ws_recoverable")?.status, "pruned");
  assert.equal(store.getSession("ws_recoverable")?.recoveryKind, "stash");
  assert.equal(unwrap(store.touchSession("ws_recoverable")), false);

  assert.equal(unwrap(store.reactivateSession("ws_recoverable")), true);
  assert.equal(store.getSession("ws_recoverable")?.status, "active");
  assert.equal(store.getSession("ws_recoverable")?.recoveryKind, undefined);
});

test("task checkpoints persist per workspace session and update in place", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  store.createSession({
    id: "ws_task",
    root: "/tmp/task",
    mode: "checkout",
  });
  const first = store.setTaskCheckpoint({
    workspaceSessionId: "ws_task",
    status: "active",
    summary: "Implemented the first slice.",
    nextStep: "Run focused tests.",
    snapshotRef: "a".repeat(40),
  });
  assert.deepEqual(store.getTaskCheckpoint("ws_task"), first);

  const second = store.setTaskCheckpoint({
    workspaceSessionId: "ws_task",
    status: "blocked",
    summary: "Focused tests exposed a migration issue.",
    nextStep: "Fix migration coverage.",
    snapshotRef: "b".repeat(40),
  });
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.status, "blocked");
  assert.equal(second.snapshotRef, "b".repeat(40));
  assert.deepEqual(store.getTaskCheckpoint("ws_task"), second);

  unwrap(store.deleteSession("ws_task"));
  assert.equal(store.getTaskCheckpoint("ws_task"), undefined);
});

function unwrap<T, E>(result: BetterResult<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}
