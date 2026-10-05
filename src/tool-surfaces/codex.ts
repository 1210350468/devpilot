import * as z from "zod/v4";
import { applyPatch } from "../apply-patch.js";
import { readFileTool } from "../pi-tools.js";
import {
  MAX_PROCESS_YIELD_MS,
  type ProcessSnapshot,
} from "../process-sessions.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  logToolCall,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";
import {
  captureWorkspaceTaskSnapshot,
  readWorkspaceDelta,
} from "../workspace-delta.js";
import { conversationScopeIdFromRequestMeta } from "../request-meta.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_INSTRUCTIONS = `Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope. After a workspace is open, prefer workspace_turn when several independent reads, short commands, process polls, or task-state operations are already known; keep individual tool calls for adaptive steps where one result determines the next action. In a continued Chat or attached Goal, workspace_turn may omit workspace_id when the server can resolve exactly one current workspace; if resolution is ambiguous it fails closed and you must provide an explicit id. For multi-turn work that is likely to continue, save a concise workspace_turn checkpoint after meaningful progress. When open_workspace returns a resume checkpoint, prefer a workspace_turn delta before broadly rereading project files.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) {
    register(context);
  }
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerCodexProcessTools,
  registerWorkspaceTurnTool,
];

const MAX_HOST_PROCESS_YIELD_MS = 4_000;

const workspaceTurnReadSchema = z.object({
  kind: z.literal("read"),
  path: z.string().describe("File path relative to the workspace, an advertised skill path, or a Goal recovery path returned by goal."),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

const workspaceTurnExecSchema = z.object({
  kind: z.literal("exec"),
  cmd: z.string().min(1).describe("Shell command to execute."),
  working_directory: z.string().optional(),
  yield_time_ms: z.number().int().min(0).max(MAX_PROCESS_YIELD_MS).optional().describe(
    "Requested synchronous wait for this command. workspace_turn defaults to 750ms and shares a 6000ms aggregate process-wait budget across the whole batch; longer work returns a session_id for later polling.",
  ),
  max_output_tokens: z.number().int().positive().max(100_000).optional(),
});

const workspaceTurnPollSchema = z.object({
  kind: z.literal("poll"),
  session_id: z.number().int().positive(),
  chars: z.string().optional(),
  yield_time_ms: z.number().int().min(0).max(MAX_PROCESS_YIELD_MS).optional().describe(
    "Requested synchronous wait for this poll. workspace_turn defaults to 1000ms and shares a 6000ms aggregate process-wait budget across the whole batch.",
  ),
  max_output_tokens: z.number().int().positive().max(100_000).optional(),
});

const workspaceTurnCheckpointSchema = z.object({
  kind: z.literal("checkpoint"),
  status: z.enum(["active", "blocked", "done"]).optional(),
  summary: z
    .string()
    .min(1)
    .max(1600)
    .describe("Concise durable summary of the current task state. Do not copy the conversation transcript."),
  next_step: z
    .string()
    .min(1)
    .max(800)
    .optional()
    .describe("The next concrete host action if work should continue."),
});

const workspaceTurnDeltaSchema = z.object({
  kind: z.literal("delta"),
  max_files: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum changed paths to return. Defaults to 20."),
});

const workspaceTurnOperationSchema = z.discriminatedUnion("kind", [
  workspaceTurnReadSchema,
  workspaceTurnExecSchema,
  workspaceTurnPollSchema,
  workspaceTurnCheckpointSchema,
  workspaceTurnDeltaSchema,
]);

type WorkspaceTurnOperation = z.infer<typeof workspaceTurnOperationSchema>;

type WorkspaceTurnStep = {
  index: number;
  kind: WorkspaceTurnOperation["kind"];
  ok: boolean;
  label: string;
  result?: string;
  session_id?: number;
  running?: boolean;
  exit_code?: number;
  output_truncated?: boolean;
  checkpoint_status?: "active" | "blocked" | "done";
  checkpoint_updated_at?: string;
  changed_files?: string[];
  changed_file_count?: number;
  omitted_files?: number;
  additions?: number;
  removals?: number;
  result_truncated?: boolean;
};

const DEFAULT_WORKSPACE_TURN_RESULT_CHARS = 32_000;
const MIN_WORKSPACE_TURN_RESULT_CHARS = 4_000;
const MAX_WORKSPACE_TURN_RESULT_CHARS = 96_000;
const DEFAULT_WORKSPACE_TURN_EXEC_YIELD_MS = 750;
const DEFAULT_WORKSPACE_TURN_POLL_YIELD_MS = 1_000;
const WORKSPACE_TURN_PROCESS_WAIT_BUDGET_MS = 6_000;
const WORKSPACE_TURN_TRUNCATION_NOTICE =
  "\n[workspace_turn result truncated to the turn context budget; use a focused read/exec if more detail is needed.]";

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}`
    : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    session_id: z.number().optional(),
    running: z.boolean(),
    exit_code: z.number().int().optional(),
    signal: z.string().optional(),
    wall_time_ms: z.number().nonnegative(),
    output_truncated: z.boolean(),
  });
}

function processToolResponse(snapshot: ProcessSnapshot) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      result,
      session_id: snapshot.sessionId,
      running: snapshot.running,
      exit_code: snapshot.exitCode,
      signal: snapshot.signal,
      wall_time_ms: snapshot.wallTimeMs,
      output_truncated: snapshot.outputTruncated,
    },
  };
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style patch to add, overwrite, update, delete, or move workspace files. Paths must be relative to the workspace.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        patch: z
          .string()
          .describe(
            "Patch text enclosed by *** Begin Patch and *** End Patch markers.",
          ),
      },
      outputSchema: resultOutputSchema({
        additions: z.number(),
        removals: z.number(),
        files: z.array(
          z.object({
            path: z.string(),
            previous_path: z.string().optional(),
            operation: z.enum(["add", "update", "delete", "move"]),
          }),
        ),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, patch }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return applyPatch(workspace.root, patch);
        },
      );
      const paths = applied.files.map((file) => file.path).join(", ");
      const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
      const content = [textBlock(result)];

      return {
        content,
        structuredContent: {
          result,
          additions: applied.additions,
          removals: applied.removals,
          files: applied.files.map(({ previousPath, ...file }) => ({
            ...file,
            previous_path: previousPath,
          })),
        },
      };
    },
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions } = context;

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a shell command in a workspace with the user's local permissions. Returns the result when it exits during the yield window, otherwise returns a session_id for write_stdin.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe(
            "Allocate a pseudo-terminal for interactive commands. Defaults to false.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY width. Defaults to 80."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY height. Defaults to 24."),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_HOST_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait before returning a running session. Defaults to 2000 for faster feedback on long commands, maximum 4000. Use write_stdin for work that runs longer.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      cmd,
      tty,
      columns,
      rows,
      working_directory,
      yield_time_ms,
      max_output_tokens,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workingDirectory = working_directory;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
        },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          const cwd = workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          return processSessions.start({
            workspaceId,
            command: cmd,
            cwd,
            workspaceRoot: workspace.root,
            tty,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
      );

      return processToolResponse(snapshot);
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspace_id: z
          .string()
          .describe("Workspace identifier used to start the process."),
        session_id: z
          .number()
          .describe("Process session identifier returned by exec_command."),
        chars: z
          .string()
          .optional()
          .describe(
            "Characters to write. Omit or pass an empty string to poll.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this width."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this height."),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_HOST_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait for process output or completion. Maximum 4000; polling defaults to 2000 and interactive writes remain short. Poll again for longer work instead of holding one MCP request open.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      session_id,
      chars,
      columns,
      rows,
      yield_time_ms,
      max_output_tokens,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const sessionId = session_id;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const snapshot = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          return processSessions.write({
            workspaceId,
            sessionId,
            chars,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
      );

      return processToolResponse(snapshot);
    },
  );
}

function registerWorkspaceTurnTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions, resolveWorkspaceIdForConversation } = context;

  server.registerTool(
    "workspace_turn",
    {
      title: "Workspace turn",
      description:
        "Execute a small ordered batch of already-planned workspace operations in one MCP round trip. Combine independent reads, short commands, process polls, task checkpoints, and checkpoint deltas. workspace_id may be omitted only when the current Chat is unambiguously bound to one active Goal/workspace; otherwise open_workspace first or provide it explicitly. Each step returns its model-readable result. Keep adaptive decisions in the host: if one result determines what to do next, return and reason before sending another turn.",
      inputSchema: {
        workspace_id: z
          .string()
          .optional()
          .describe(
            "Workspace to use. Omit only when this Chat is already unambiguously bound to one active Goal/workspace; otherwise provide the workspace_id returned by open_workspace.",
          ),
        operations: z
          .array(workspaceTurnOperationSchema)
          .min(1)
          .max(8)
          .describe("Ordered operations to execute. Maximum 8 operations per turn to keep results bounded."),
        stop_on_error: z
          .boolean()
          .optional()
          .describe("Stop after the first failed read or non-zero completed command. Defaults to true."),
        max_result_chars: z
          .number()
          .int()
          .min(MIN_WORKSPACE_TURN_RESULT_CHARS)
          .max(MAX_WORKSPACE_TURN_RESULT_CHARS)
          .optional()
          .describe(
            "Total character budget for model-readable step results. Defaults to 32000; unused budget is redistributed across later steps.",
          ),
      },
      outputSchema: resultOutputSchema({
        workspace_id: z.string(),
        completed: z.number().int().nonnegative(),
        requested: z.number().int().positive(),
        stopped_early: z.boolean(),
        result_char_budget: z.number().int().positive(),
        result_chars: z.number().int().nonnegative(),
        truncated_results: z.number().int().nonnegative(),
        steps: z.array(z.object({
          index: z.number().int().nonnegative(),
          kind: z.enum(["read", "exec", "poll", "checkpoint", "delta"]),
          ok: z.boolean(),
          label: z.string(),
          result: z.string().optional(),
          session_id: z.number().int().optional(),
          running: z.boolean().optional(),
          exit_code: z.number().int().optional(),
          output_truncated: z.boolean().optional(),
          checkpoint_status: z.enum(["active", "blocked", "done"]).optional(),
          checkpoint_updated_at: z.string().optional(),
          changed_files: z.array(z.string()).optional(),
          changed_file_count: z.number().int().nonnegative().optional(),
          omitted_files: z.number().int().nonnegative().optional(),
          additions: z.number().int().nonnegative().optional(),
          removals: z.number().int().nonnegative().optional(),
          result_truncated: z.boolean().optional(),
        })),
      }),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, operations, stop_on_error, max_result_chars }, { _meta }) => {
      const startedAt = performance.now();
      let workspaceId = workspace_id;
      if (!workspaceId) {
        const conversationScopeId = conversationScopeIdFromRequestMeta(_meta);
        if (!conversationScopeId || !resolveWorkspaceIdForConversation) {
          throw new Error(
            "workspace_turn requires workspace_id unless the current Chat is already bound to one active Goal/workspace. Call open_workspace first or provide workspace_id explicitly.",
          );
        }
        workspaceId = await resolveWorkspaceIdForConversation(conversationScopeId);
        if (!workspaceId) {
          throw new Error(
            "No active workspace is bound to this Chat. Call open_workspace first or provide workspace_id explicitly.",
          );
        }
      }
      const stopOnError = stop_on_error ?? true;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const steps: WorkspaceTurnStep[] = [];
      const processWaitDeadline = performance.now() + WORKSPACE_TURN_PROCESS_WAIT_BUDGET_MS;

      for (const [index, operation] of operations.entries()) {
        if (operation.kind === "read") {
          const readPath = workspaces.resolveReadPath(workspace, operation.path);
          const response = await readFileTool(
            {
              path: readPath.absolutePath,
              offset: operation.offset,
              limit: operation.limit,
            },
            {
              cwd: workspace.root,
              root: workspace.root,
              readRoots: readPath.readRoots,
            },
          );
          const step: WorkspaceTurnStep = {
            index,
            kind: operation.kind,
            ok: !response.isError,
            label: operation.path,
            result: contentText(response.content),
          };
          steps.push(step);
          if (response.isError && stopOnError) break;
          continue;
        }

        if (operation.kind === "exec") {
          const cwd = workspaces.resolveWorkingDirectory(workspace, operation.working_directory);
          const yieldTimeMs = workspaceTurnYieldTime(
            operation.yield_time_ms,
            DEFAULT_WORKSPACE_TURN_EXEC_YIELD_MS,
            processWaitDeadline,
          );
          const snapshot = await processSessions.start({
            workspaceId,
            command: operation.cmd,
            cwd,
            workspaceRoot: workspace.root,
            yieldTimeMs,
            maxOutputTokens: operation.max_output_tokens,
          });
          const ok = snapshot.running || snapshot.exitCode === 0;
          steps.push(workspaceTurnProcessStep(index, operation.kind, operation.cmd, snapshot, ok));
          if (!ok && stopOnError) break;
          continue;
        }

        if (operation.kind === "checkpoint") {
          const snapshot = await captureWorkspaceTaskSnapshot({
            workspaceId,
            root: workspace.root,
          });
          const checkpoint = workspaces.setTaskCheckpoint(workspaceId, {
            status: operation.status ?? "active",
            summary: operation.summary,
            nextStep: operation.next_step,
            snapshotRef: snapshot.available ? snapshot.snapshotRef : undefined,
          });
          const snapshotNote = snapshot.available
            ? "Git delta baseline captured."
            : `Git delta unavailable: ${snapshot.reason}`;
          steps.push({
            index,
            kind: operation.kind,
            ok: true,
            label: "task checkpoint",
            result: [
              `Task checkpoint saved as ${checkpoint.status}.`,
              `Summary: ${checkpoint.summary}`,
              checkpoint.nextStep ? `Next: ${checkpoint.nextStep}` : undefined,
              snapshotNote,
            ].filter(Boolean).join("\n"),
            checkpoint_status: checkpoint.status,
            checkpoint_updated_at: checkpoint.updatedAt,
          });
          continue;
        }

        if (operation.kind === "delta") {
          const checkpoint = workspaces.getTaskCheckpoint(workspaceId);
          if (!checkpoint) {
            steps.push({
              index,
              kind: operation.kind,
              ok: false,
              label: "task delta",
              result: "No task checkpoint exists for this workspace. Save a checkpoint before requesting a delta.",
            });
            if (stopOnError) break;
            continue;
          }
          if (!checkpoint.snapshotRef) {
            steps.push({
              index,
              kind: operation.kind,
              ok: false,
              label: "task delta",
              result: "The current task checkpoint has no Git snapshot, so a workspace delta is unavailable. Save a fresh checkpoint in a Git workspace.",
              checkpoint_status: checkpoint.status,
              checkpoint_updated_at: checkpoint.updatedAt,
            });
            if (stopOnError) break;
            continue;
          }

          try {
            const delta = await readWorkspaceDelta({
              workspaceId,
              root: workspace.root,
              snapshotRef: checkpoint.snapshotRef,
              maxFiles: operation.max_files,
            });
            const fileSummary = delta.totalFiles === 0
              ? "No workspace files changed since the checkpoint."
              : `Changed ${delta.totalFiles} file(s) since the checkpoint (+${delta.additions}/-${delta.removals}): ${delta.changedFiles.join(", ")}${delta.omittedFiles > 0 ? ` (+${delta.omittedFiles} more)` : ""}.`;
            steps.push({
              index,
              kind: operation.kind,
              ok: true,
              label: "task delta",
              result: [
                `Checkpoint ${checkpoint.status} from ${checkpoint.updatedAt}.`,
                `Summary: ${checkpoint.summary}`,
                checkpoint.nextStep ? `Next: ${checkpoint.nextStep}` : undefined,
                fileSummary,
              ].filter(Boolean).join("\n"),
              checkpoint_status: checkpoint.status,
              checkpoint_updated_at: checkpoint.updatedAt,
              changed_files: delta.changedFiles,
              changed_file_count: delta.totalFiles,
              omitted_files: delta.omittedFiles,
              additions: delta.additions,
              removals: delta.removals,
            });
          } catch (error) {
            steps.push({
              index,
              kind: operation.kind,
              ok: false,
              label: "task delta",
              result: error instanceof Error ? error.message : String(error),
              checkpoint_status: checkpoint.status,
              checkpoint_updated_at: checkpoint.updatedAt,
            });
            if (stopOnError) break;
          }
          continue;
        }

        const yieldTimeMs = workspaceTurnYieldTime(
          operation.yield_time_ms,
          DEFAULT_WORKSPACE_TURN_POLL_YIELD_MS,
          processWaitDeadline,
        );
        const snapshot = await processSessions.write({
          workspaceId,
          sessionId: operation.session_id,
          chars: operation.chars,
          yieldTimeMs,
          maxOutputTokens: operation.max_output_tokens,
        });
        const ok = snapshot.running || snapshot.exitCode === 0;
        steps.push(workspaceTurnProcessStep(
          index,
          operation.kind,
          `session ${operation.session_id}`,
          snapshot,
          ok,
        ));
        if (!ok && stopOnError) break;
      }

      const stoppedEarly = steps.length < operations.length;
      const resultCharBudget = max_result_chars ?? DEFAULT_WORKSPACE_TURN_RESULT_CHARS;
      const budgeted = applyWorkspaceTurnResultBudget(steps, resultCharBudget);
      const result = `Workspace turn completed ${steps.length}/${operations.length} operation(s)${stoppedEarly ? " and stopped early" : ""}.`;
      logToolCall(config, {
        tool: "workspace_turn",
        workspaceId,
        success: steps.every((step) => step.ok),
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          workspace_id: workspaceId,
          completed: steps.length,
          requested: operations.length,
          stopped_early: stoppedEarly,
          result_char_budget: resultCharBudget,
          result_chars: budgeted.resultChars,
          truncated_results: budgeted.truncatedResults,
          steps: budgeted.steps,
        },
      };
    },
  );
}

function workspaceTurnYieldTime(requested: number | undefined, fallback: number, deadline: number): number {
  const desired = requested ?? fallback;
  const remaining = Math.max(0, Math.floor(deadline - performance.now()));
  return Math.min(desired, remaining);
}

function applyWorkspaceTurnResultBudget(
  steps: WorkspaceTurnStep[],
  resultCharBudget: number,
): { steps: WorkspaceTurnStep[]; resultChars: number; truncatedResults: number } {
  let remaining = resultCharBudget;
  let resultChars = 0;
  let truncatedResults = 0;
  const budgeted = steps.map((step, index) => {
    if (step.result === undefined) return step;
    const remainingSteps = Math.max(1, steps.length - index);
    const fairShare = Math.max(0, Math.floor(remaining / remainingSteps));
    const result = truncateWorkspaceTurnResult(step.result, fairShare);
    remaining = Math.max(0, remaining - result.text.length);
    resultChars += result.text.length;
    if (result.truncated) truncatedResults += 1;
    return {
      ...step,
      result: result.text,
      result_truncated: result.truncated || undefined,
    };
  });
  return { steps: budgeted, resultChars, truncatedResults };
}

function truncateWorkspaceTurnResult(
  result: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (result.length <= maxChars) return { text: result, truncated: false };
  if (maxChars <= 0) return { text: "", truncated: true };
  if (maxChars <= WORKSPACE_TURN_TRUNCATION_NOTICE.length) {
    return {
      text: WORKSPACE_TURN_TRUNCATION_NOTICE.slice(0, maxChars),
      truncated: true,
    };
  }
  return {
    text: `${result.slice(0, maxChars - WORKSPACE_TURN_TRUNCATION_NOTICE.length)}${WORKSPACE_TURN_TRUNCATION_NOTICE}`,
    truncated: true,
  };
}

function workspaceTurnProcessStep(
  index: number,
  kind: "exec" | "poll",
  label: string,
  snapshot: ProcessSnapshot,
  ok: boolean,
): WorkspaceTurnStep {
  return {
    index,
    kind,
    ok,
    label,
    result: processResult(snapshot),
    session_id: snapshot.sessionId,
    running: snapshot.running,
    exit_code: snapshot.exitCode,
    output_truncated: snapshot.outputTruncated,
  };
}
