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

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_INSTRUCTIONS = `Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope. After a workspace is open, prefer workspace_turn when several independent reads, short commands, or process polls are already known; keep individual tool calls for adaptive steps where one result determines the next action.`;

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

const workspaceTurnReadSchema = z.object({
  kind: z.literal("read"),
  path: z.string().describe("File path relative to the workspace, or an advertised skill path."),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

const workspaceTurnExecSchema = z.object({
  kind: z.literal("exec"),
  cmd: z.string().min(1).describe("Shell command to execute."),
  working_directory: z.string().optional(),
  yield_time_ms: z.number().int().min(0).max(MAX_PROCESS_YIELD_MS).optional(),
  max_output_tokens: z.number().int().positive().max(100_000).optional(),
});

const workspaceTurnPollSchema = z.object({
  kind: z.literal("poll"),
  session_id: z.number().int().positive(),
  chars: z.string().optional(),
  yield_time_ms: z.number().int().min(0).max(MAX_PROCESS_YIELD_MS).optional(),
  max_output_tokens: z.number().int().positive().max(100_000).optional(),
});

const workspaceTurnOperationSchema = z.discriminatedUnion("kind", [
  workspaceTurnReadSchema,
  workspaceTurnExecSchema,
  workspaceTurnPollSchema,
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
};

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
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait before returning a running session. Defaults to 10000, maximum 12000. Use write_stdin for work that runs longer.",
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
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait for process output or completion. Maximum 12000; polling defaults to 5000 and interactive writes to 250.",
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
  const { server, config, workspaces, processSessions } = context;

  server.registerTool(
    "workspace_turn",
    {
      title: "Workspace turn",
      description:
        "Execute a small ordered batch of already-planned workspace operations in one MCP round trip. Use this to combine independent reads, short commands, and process polls after open_workspace. Each step returns its model-readable result. Keep adaptive decisions in the host: if one result determines what to do next, return and reason before sending another turn.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        operations: z
          .array(workspaceTurnOperationSchema)
          .min(1)
          .max(8)
          .describe("Ordered operations to execute. Maximum 8 operations per turn to keep results bounded."),
        stop_on_error: z
          .boolean()
          .optional()
          .describe("Stop after the first failed read or non-zero completed command. Defaults to true."),
      },
      outputSchema: resultOutputSchema({
        completed: z.number().int().nonnegative(),
        requested: z.number().int().positive(),
        stopped_early: z.boolean(),
        steps: z.array(z.object({
          index: z.number().int().nonnegative(),
          kind: z.enum(["read", "exec", "poll"]),
          ok: z.boolean(),
          label: z.string(),
          result: z.string().optional(),
          session_id: z.number().int().optional(),
          running: z.boolean().optional(),
          exit_code: z.number().int().optional(),
          output_truncated: z.boolean().optional(),
        })),
      }),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, operations, stop_on_error }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const stopOnError = stop_on_error ?? true;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const steps: WorkspaceTurnStep[] = [];

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
          const snapshot = await processSessions.start({
            workspaceId,
            command: operation.cmd,
            cwd,
            workspaceRoot: workspace.root,
            yieldTimeMs: operation.yield_time_ms,
            maxOutputTokens: operation.max_output_tokens,
          });
          const ok = snapshot.running || snapshot.exitCode === 0;
          steps.push(workspaceTurnProcessStep(index, operation.kind, operation.cmd, snapshot, ok));
          if (!ok && stopOnError) break;
          continue;
        }

        const snapshot = await processSessions.write({
          workspaceId,
          sessionId: operation.session_id,
          chars: operation.chars,
          yieldTimeMs: operation.yield_time_ms,
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
          completed: steps.length,
          requested: operations.length,
          stopped_early: stoppedEarly,
          steps,
        },
      };
    },
  );
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
