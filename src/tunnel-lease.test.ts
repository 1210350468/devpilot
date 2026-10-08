import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireTunnelLease, TunnelLeaseConflictError } from "./tunnel-lease.js";

const TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef";

test("OpenAI tunnel lease prevents two live DevPilot backends from owning one Tunnel ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "devpilot-tunnel-lease-"));
  try {
    const first = await acquireTunnelLease({ tunnelId: TUNNEL_ID, projectRoot: "first", controlPort: 1, rootDir: root });
    await assert.rejects(
      acquireTunnelLease({ tunnelId: TUNNEL_ID, projectRoot: "second", controlPort: 2, rootDir: root }),
      (error: unknown) => error instanceof TunnelLeaseConflictError
        && error.owner.pid === process.pid
        && error.owner.projectRoot === "first",
    );
    await first.release();
    const second = await acquireTunnelLease({ tunnelId: TUNNEL_ID, projectRoot: "second", controlPort: 2, rootDir: root });
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAI tunnel lease reclaims a stale crashed owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "devpilot-tunnel-lease-stale-"));
  try {
    const path = join(root, TUNNEL_ID);
    await mkdir(path);
    await writeFile(join(path, "owner.json"), JSON.stringify({
      tunnelId: TUNNEL_ID,
      pid: 2_147_483_647,
      projectRoot: "stale",
      startedAt: new Date(0).toISOString(),
      nonce: "stale-owner",
    }));
    const lease = await acquireTunnelLease({ tunnelId: TUNNEL_ID, projectRoot: "replacement", rootDir: root });
    assert.equal(lease.owner.projectRoot, "replacement");
    await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAI tunnel lease rejects malformed Tunnel IDs", async () => {
  await assert.rejects(
    acquireTunnelLease({ tunnelId: "tunnel_bad", projectRoot: "bad", rootDir: tmpdir() }),
    /Invalid OpenAI Tunnel ID/,
  );
});
