import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { assertAllowedPath } from "./roots.js";
import { writeDevspaceConfig } from "./user-config.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";

test("Full Access is opt-in, applies to workspaces and CLI, and reverts without losing saved roots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devpilot-full-access-"));
  try {
    const home = join(dir, "home");
    const desktop = join(dir, "desktop");
    const env = { DEVSPACE_CONFIG_DIR: join(dir, "config"), DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-long-enough" };
    const write = (permissionMode: "restricted" | "full") => writeDevspaceConfig({
      configVersion: 1,
      workspaces: { permissionMode, allowedRoots: [home], worktreeRoot: join(dir, "worktrees") },
    }, env);

    write("restricted");
    const restricted = loadConfig(env);
    assert.equal(restricted.permissionMode, "restricted");
    assert.throws(() => assertAllowedPath(desktop, restricted.allowedRoots), /outside allowed roots/);
    await assert.rejects(() => new WorkspaceRegistry(restricted).openWorkspace(desktop), /outside allowed roots/);

    write("full");
    const full = loadConfig(env);
    assert.equal(full.permissionMode, "full");
    assert.deepEqual(full.allowedRoots, ["*"]);
    assert.equal(assertAllowedPath(desktop, full.allowedRoots), resolve(desktop));
    const opened = await new WorkspaceRegistry(full).openWorkspace(desktop);
    assert.equal(opened.workspace.root, resolve(desktop));
    assert.equal(resolveCliWorkspaceContext(full.allowedRoots, {
      DEVSPACE_WORKSPACE_ID: "test",
      DEVSPACE_WORKSPACE_ROOT: desktop,
    }).workspaceRoot, resolve(desktop));

    write("restricted");
    const reset = loadConfig(env);
    assert.deepEqual(reset.allowedRoots, [resolve(home)]);
    assert.throws(() => assertAllowedPath(desktop, reset.allowedRoots), /outside allowed roots/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
