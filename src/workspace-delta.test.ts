import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  captureWorkspaceTaskSnapshot,
  readWorkspaceDelta,
} from "./workspace-delta.js";

const execFileAsync = promisify(execFile);

test("workspace delta reports bounded changed paths since a task checkpoint", async (t) => {
  const root = await committedRepository(t);
  const checkpoint = await captureWorkspaceTaskSnapshot({ workspaceId: "ws_delta", root });
  assert.equal(checkpoint.available, true);
  if (!checkpoint.available) return;

  await writeFile(join(root, "README.md"), "hello\nchanged\n");
  await writeFile(join(root, "new.txt"), "new\n");

  const delta = await readWorkspaceDelta({
    workspaceId: "ws_delta",
    root,
    snapshotRef: checkpoint.snapshotRef,
    maxFiles: 1,
  });
  assert.equal(delta.totalFiles, 2);
  assert.equal(delta.changedFiles.length, 1);
  assert.equal(delta.omittedFiles, 1);
  assert.equal(delta.additions, 2);
  assert.equal(delta.removals, 0);
});

test("a fresh task checkpoint resets the delta baseline", async (t) => {
  const root = await committedRepository(t);
  const first = await captureWorkspaceTaskSnapshot({ workspaceId: "ws_reset", root });
  assert.equal(first.available, true);
  await writeFile(join(root, "README.md"), "hello\nfirst\n");
  const second = await captureWorkspaceTaskSnapshot({ workspaceId: "ws_reset", root });
  assert.equal(second.available, true);
  if (!second.available) return;

  const clean = await readWorkspaceDelta({
    workspaceId: "ws_reset",
    root,
    snapshotRef: second.snapshotRef,
  });
  assert.equal(clean.totalFiles, 0);
  assert.deepEqual(clean.changedFiles, []);
});

test("workspace delta rejects a persisted snapshot that no longer owns the task ref", async (t) => {
  const root = await committedRepository(t);
  const first = await captureWorkspaceTaskSnapshot({ workspaceId: "ws_stale", root });
  assert.equal(first.available, true);
  if (!first.available) return;
  await writeFile(join(root, "README.md"), "hello\nnew checkpoint\n");
  const second = await captureWorkspaceTaskSnapshot({ workspaceId: "ws_stale", root });
  assert.equal(second.available, true);

  await assert.rejects(
    () => readWorkspaceDelta({
      workspaceId: "ws_stale",
      root,
      snapshotRef: first.snapshotRef,
    }),
    /missing or no longer matches persisted task state/i,
  );
});

async function committedRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-delta-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Initial commit"]);
  return root;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
