import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;
const OWNER_FILE = "owner.json";
const INITIALIZATION_GRACE_MS = 2_000;
const RETRY_DELAY_MS = 50;
const MAX_ACQUIRE_ATTEMPTS = 40;

export interface TunnelLeaseOwner {
  tunnelId: string;
  pid: number;
  projectRoot: string;
  controlPort?: number;
  mcpPort?: number;
  startedAt: string;
  nonce: string;
}

export interface TunnelLease {
  owner: TunnelLeaseOwner;
  path: string;
  release(): Promise<void>;
}

export class TunnelLeaseConflictError extends Error {
  readonly code = "TUNNEL_LEASE_CONFLICT";

  constructor(readonly tunnelId: string, readonly owner: TunnelLeaseOwner) {
    const location = owner.projectRoot ? ` at ${owner.projectRoot}` : "";
    const control = owner.controlPort ? ` (control ${owner.controlPort})` : "";
    super(`OpenAI Secure Tunnel ${tunnelId} is already owned by DevPilot PID ${owner.pid}${location}${control}. Stop that instance before starting another backend on the same Tunnel ID.`);
    this.name = "TunnelLeaseConflictError";
  }
}

export function defaultTunnelLeaseRoot(): string {
  return join(homedir(), ".devspace", "tunnel-leases");
}

export async function acquireTunnelLease(input: {
  tunnelId: string;
  projectRoot: string;
  controlPort?: number;
  mcpPort?: number;
  rootDir?: string;
}): Promise<TunnelLease> {
  if (!TUNNEL_ID.test(input.tunnelId)) throw new Error(`Invalid OpenAI Tunnel ID for lease: ${input.tunnelId}`);
  const root = input.rootDir ?? defaultTunnelLeaseRoot();
  await mkdir(root, { recursive: true });
  const leasePath = join(root, input.tunnelId);

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(leasePath);
      const owner: TunnelLeaseOwner = {
        tunnelId: input.tunnelId,
        pid: process.pid,
        projectRoot: input.projectRoot,
        controlPort: input.controlPort,
        mcpPort: input.mcpPort,
        startedAt: new Date().toISOString(),
        nonce: randomUUID(),
      };
      try {
        await writeFile(join(leasePath, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      } catch (error) {
        await rm(leasePath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return createLease(leasePath, owner);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const existing = await readOwner(leasePath);
    if (existing && isProcessAlive(existing.pid)) {
      throw new TunnelLeaseConflictError(input.tunnelId, existing);
    }

    if (!existing) {
      const metadata = await stat(leasePath).catch(() => undefined);
      if (metadata && Date.now() - metadata.mtimeMs < INITIALIZATION_GRACE_MS) {
        await delay(RETRY_DELAY_MS);
        continue;
      }
    }

    const stalePath = `${leasePath}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(leasePath, stalePath);
      await rm(stalePath, { recursive: true, force: true });
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "EEXIST") throw error;
    }
  }

  throw new Error(`Unable to acquire OpenAI Tunnel lease for ${input.tunnelId} after repeated contention.`);
}

function createLease(path: string, owner: TunnelLeaseOwner): TunnelLease {
  let released = false;
  return {
    owner,
    path,
    async release() {
      if (released) return;
      released = true;
      const current = await readOwner(path);
      if (!current || current.nonce !== owner.nonce || current.pid !== owner.pid) return;
      const releasedPath = `${path}.released-${process.pid}-${randomUUID()}`;
      try {
        await rename(path, releasedPath);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      await rm(releasedPath, { recursive: true, force: true });
    },
  };
}

async function readOwner(path: string): Promise<TunnelLeaseOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(join(path, OWNER_FILE), "utf8")) as Partial<TunnelLeaseOwner>;
    if (
      typeof value.tunnelId !== "string"
      || typeof value.pid !== "number"
      || !Number.isInteger(value.pid)
      || value.pid <= 0
      || typeof value.projectRoot !== "string"
      || typeof value.startedAt !== "string"
      || typeof value.nonce !== "string"
    ) return undefined;
    return value as TunnelLeaseOwner;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
