import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitEligibility, git, safeWorkspaceRefSegment } from "./git.js";

export type WorkspaceTaskSnapshot =
  | { available: true; snapshotRef: string }
  | { available: false; reason: string };

export interface WorkspaceDeltaResult {
  changedFiles: string[];
  totalFiles: number;
  omittedFiles: number;
  additions: number;
  removals: number;
}

const TASK_REF_PREFIX = "refs/devspace/task";

export async function captureWorkspaceTaskSnapshot(input: {
  workspaceId: string;
  root: string;
}): Promise<WorkspaceTaskSnapshot> {
  const eligibility = await getGitEligibility(input.root);
  if (!eligibility.ok || !eligibility.gitRoot) {
    return {
      available: false,
      reason: eligibility.message ?? "Workspace delta requires a Git workspace.",
    };
  }

  const head = (await git(eligibility.gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  const snapshotRef = await createWorkingTreeSnapshot(eligibility.gitRoot, head);
  await git(eligibility.gitRoot, ["update-ref", taskRef(input.workspaceId), snapshotRef]);
  return { available: true, snapshotRef };
}

export async function readWorkspaceDelta(input: {
  workspaceId: string;
  root: string;
  snapshotRef: string;
  maxFiles?: number;
}): Promise<WorkspaceDeltaResult> {
  const eligibility = await getGitEligibility(input.root);
  if (!eligibility.ok || !eligibility.gitRoot) {
    throw new Error(eligibility.message ?? "Workspace delta requires a Git workspace.");
  }

  const liveCheckpoint = await commitForRef(eligibility.gitRoot, taskRef(input.workspaceId));
  if (!liveCheckpoint || liveCheckpoint !== input.snapshotRef) {
    throw new Error(
      "The task checkpoint Git snapshot is missing or no longer matches persisted task state. Save a fresh checkpoint before requesting another delta.",
    );
  }

  const current = await createWorkingTreeSnapshot(eligibility.gitRoot, input.snapshotRef);
  const [nameOutput, numstatOutput] = await Promise.all([
    git(eligibility.gitRoot, [
      "diff",
      "--name-only",
      "-z",
      "--find-renames",
      input.snapshotRef,
      current,
    ]),
    git(eligibility.gitRoot, [
      "diff",
      "--numstat",
      "-z",
      "--find-renames",
      input.snapshotRef,
      current,
    ]),
  ]);

  const allFiles = nameOutput.stdout.split("\0").filter(Boolean);
  const maxFiles = Math.max(1, Math.min(input.maxFiles ?? 20, 50));
  const stats = summarizeNumstat(numstatOutput.stdout);
  return {
    changedFiles: allFiles.slice(0, maxFiles),
    totalFiles: allFiles.length,
    omittedFiles: Math.max(0, allFiles.length - maxFiles),
    additions: stats.additions,
    removals: stats.removals,
  };
}

function taskRef(workspaceId: string): string {
  return `${TASK_REF_PREFIX}/${safeWorkspaceRefSegment(workspaceId)}/checkpoint`;
}

async function createWorkingTreeSnapshot(gitRoot: string, parent: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-task-index-"));
  const indexPath = join(tempDir, "index");
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "DevSpace",
    GIT_AUTHOR_EMAIL: "devspace@localhost",
    GIT_COMMITTER_NAME: "DevSpace",
    GIT_COMMITTER_EMAIL: "devspace@localhost",
  };

  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    await git(gitRoot, ["add", "-A", "--", "."], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    return (await git(gitRoot, [
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      "DevSpace task checkpoint",
    ], { env })).stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function commitForRef(gitRoot: string, ref: string): Promise<string | undefined> {
  try {
    return (await git(gitRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
  } catch {
    return undefined;
  }
}

function summarizeNumstat(output: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const record of output.split("\0")) {
    if (!record) continue;
    const [added, removed] = record.split("\t", 3);
    if (/^\d+$/.test(added ?? "")) additions += Number(added);
    if (/^\d+$/.test(removed ?? "")) removals += Number(removed);
  }
  return { additions, removals };
}
