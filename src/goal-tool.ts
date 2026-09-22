import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import {
  GoalNotCompleteError,
  type GoalCriterionUpdate,
  type GoalEvidence,
  type GoalResumeCapsule,
  type GoalStatus,
  type GoalStore,
  type PersistentGoal,
} from "./goal-store.js";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { logToolCall, textBlock } from "./tool-surfaces/shared.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { GoalContextStore } from "./goal-context.js";

const GOAL_ACTIONS = [
  "start",
  "attach",
  "status",
  "update",
  "checkpoint",
  "verify",
  "finish",
  "pause",
  "resume",
  "request_approval",
  "approve",
  "block",
  "fail",
  "cancel",
  "history",
] as const;

const MAX_RESUME_CAPSULE_CHARS = 12_000;

const criterionInputSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  description: z.string().min(1).max(800),
  required: z.boolean().optional(),
});

const evidenceSchema = z.object({
  kind: z.string().min(1).max(64),
  summary: z.string().min(1).max(800),
  ref: z.string().min(1).max(512).optional(),
});

const criterionUpdateSchema = z.object({
  id: z.string().min(1).max(80),
  status: z.enum(["pending", "passed", "failed", "blocked"]),
  evidence: z.array(evidenceSchema).max(20).optional(),
  verification_source: z.string().min(1).max(512).optional(),
});

const resumeCapsuleSchema = z.object({
  objective: z.string().max(2000).optional(),
  completed: z.array(z.string().max(240)).max(40).optional(),
  remaining: z.array(z.string().max(240)).max(40).optional(),
  hard_constraints: z.array(z.string().max(500)).max(30).optional(),
  decisions: z.array(z.string().max(500)).max(40).optional(),
  current_state: z.string().max(2000).optional(),
  work_completed: z.array(z.string().max(500)).max(40).optional(),
  current_problem: z.string().max(1500).optional(),
  next_actions: z.array(z.string().max(500)).max(30).optional(),
  failures: z.array(z.string().max(500)).max(30).optional(),
  evidence: z.array(z.string().max(500)).max(40).optional(),
});

const goalInputSchema = {
  action: z.enum(GOAL_ACTIONS).describe("Goal state operation."),
  goal_id: z.string().min(1).max(128).optional(),
  workspace_id: z.string().min(1).optional(),
  objective: z.string().min(1).max(4000).optional(),
  criteria: z.array(criterionInputSchema).min(1).max(50).optional(),
  constraints: z.array(z.string().min(1).max(500)).max(30).optional(),
  summary: z.string().max(2000).optional(),
  current_step: z.string().max(1000).nullable().optional(),
  next_step: z.string().max(1000).nullable().optional(),
  resume_capsule: resumeCapsuleSchema.optional(),
  criterion_updates: z.array(criterionUpdateSchema).min(1).max(50).optional(),
  event_kind: z.string().min(1).max(80).optional(),
  event_note: z.string().min(1).max(1000).optional(),
  max_rounds: z.number().int().min(1).max(1000).optional(),
  max_wall_time_minutes: z.number().int().min(1).max(10080).optional(),
  max_no_progress_rounds: z.number().int().min(1).max(100).optional(),
  max_same_failure: z.number().int().min(1).max(100).optional(),
  history_limit: z.number().int().min(1).max(100).optional(),
  resume_nonce: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
};

const criterionOutputSchema = z.object({
  id: z.string(),
  description: z.string(),
  required: z.boolean(),
  status: z.enum(["pending", "passed", "failed", "blocked"]),
  evidence: z.array(evidenceSchema),
  verification_source: z.string().optional(),
  verification_time: z.string().optional(),
});

const goalOutputSchema = z.object({
  goal_id: z.string(),
  workspace_id: z.string(),
  objective: z.string(),
  status: z.enum([
    "planning",
    "running",
    "verifying",
    "waiting_approval",
    "blocked",
    "paused",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  summary: z.string(),
  current_step: z.string().optional(),
  next_step: z.string().optional(),
  round_number: z.number().int(),
  constraints: z.array(z.string()),
  criteria: z.array(criterionOutputSchema),
  remaining_required: z.array(z.string()),
  resume_capsule: resumeCapsuleSchema,
  budgets: z.object({
    max_rounds: z.number().int(),
    max_wall_time_minutes: z.number().int(),
    max_no_progress_rounds: z.number().int(),
    max_same_failure: z.number().int(),
  }),
  updated_at: z.string(),
});

const recoveryContextOutputSchema = z.object({
  hydrate_ref: z.string(),
  manifest_ref: z.string(),
  profile: z.enum(["minimal", "normal", "debug", "verification"]),
  generated_at: z.string(),
  goal_updated_at: z.string(),
  derived: z.literal(true),
});

export function registerGoalTool(input: {
  server: McpRegistrationTarget;
  config: ServerConfig;
  goalStore: GoalStore;
  workspaces: WorkspaceRegistry;
  onGoalChanged?: () => void;
}): void {
  const { server, config, goalStore, workspaces, onGoalChanged } = input;
  const contextStore = new GoalContextStore(config.stateDir);
  server.registerTool(
    "goal",
    {
      title: "Persistent goal",
      description:
        "Create and maintain a durable GPT-native Goal that can survive tool-loop interruption and attach to a later ChatGPT conversation. Use this only when the user explicitly asks for persistent goal-style completion or when continuing an existing Goal. DevPilot stores state and evidence; the host GPT remains the reasoning agent.",
      inputSchema: goalInputSchema,
      outputSchema: {
        result: z.string(),
        goal: goalOutputSchema.optional(),
        events: z.array(z.object({
          id: z.number().int(),
          kind: z.string(),
          round_number: z.number().int(),
          payload: z.record(z.string(), z.unknown()),
          created_at: z.string(),
        })).optional(),
        recovery_context: recoveryContextOutputSchema.optional(),
        error_code: z.string().optional(),
        remaining_criteria: z.array(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (toolInput, { _meta }) => {
      const startedAt = performance.now();
      const conversationScopeId = conversationScopeIdFromRequestMeta(_meta);
      try {
        let response;
        try {
          response = await handleGoalAction({
            input: toolInput,
            conversationScopeId,
            goalStore,
            workspaces,
          });
          const responseGoalId = goalIdFromResponse(response);
          if (responseGoalId) {
            try {
              const goal = goalStore.requireGoal(responseGoalId);
              const workspace = await workspaces.getWorkspace(goal.workspaceSessionId);
              const context = await contextStore.refresh(
                goal,
                goalStore.listEvents(responseGoalId, 30),
                { workspaceRoot: workspace.root },
              );
              const structuredContent = response.structuredContent as Record<string, unknown>;
              structuredContent.recovery_context = {
                hydrate_ref: context.hydrateRef,
                manifest_ref: context.manifestRef,
                profile: context.profile,
                generated_at: context.generatedAt,
                goal_updated_at: context.goalUpdatedAt,
                derived: true,
              };
              const priorResult = typeof structuredContent.result === "string"
                ? structuredContent.result
                : "Goal operation completed.";
              structuredContent.result = `${priorResult} Recovery context: ${context.hydrateRef} (manifest: ${context.manifestRef}).`;
              response.content.push(textBlock(
                `Recovery context cache: read ${context.hydrateRef} first; expand through ${context.manifestRef} only when the current step needs more context. The cache is derived; Goal DB and workspace Git/filesystem remain authoritative.`,
              ));
            } catch {
              // Context hydration is a recovery acceleration layer, never part of Goal correctness.
              // A cache write/read failure must not turn a successful durable Goal mutation into a
              // failed MCP action.
            }
          }
        } finally {
          // The continuation service is transport/lifecycle plumbing, not Goal correctness. Wake it
          // after every Goal call so state changes become visible promptly, but never make a
          // watchdog notification part of the MCP action's success contract.
          try { onGoalChanged?.(); } catch { /* supervisor lifecycle may already be stopping */ }
        }
        logToolCall(config, {
          tool: "goal",
          success: !("isError" in response && response.isError === true),
          durationMs: Math.round(performance.now() - startedAt),
          error: "isError" in response && response.isError === true
            ? response.structuredContent.error_code
            : undefined,
        });
        return response;
      } catch (error) {
        logToolCall(config, {
          tool: "goal",
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );
}

function goalIdFromResponse(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const structured = (response as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object") return undefined;
  const goal = (structured as { goal?: unknown }).goal;
  if (!goal || typeof goal !== "object") return undefined;
  const goalId = (goal as { goal_id?: unknown }).goal_id;
  return typeof goalId === "string" ? goalId : undefined;
}

type ParsedGoalInput = z.infer<z.ZodObject<typeof goalInputSchema>>;

async function handleGoalAction(input: {
  input: ParsedGoalInput;
  conversationScopeId?: string;
  goalStore: GoalStore;
  workspaces: WorkspaceRegistry;
}) {
  const { goalStore, workspaces, conversationScopeId } = input;
  const action = input.input.action;

  if (action === "start") {
    const workspaceId = required(input.input.workspace_id, "workspace_id", action);
    const objective = required(input.input.objective, "objective", action);
    const criteria = required(input.input.criteria, "criteria", action);
    await workspaces.getWorkspace(workspaceId);
    const goal = goalStore.createGoal({
      workspaceSessionId: workspaceId,
      objective,
      criteria,
      constraints: input.input.constraints,
      conversationScopeId,
      summary: input.input.summary,
      nextStep: input.input.next_step ?? undefined,
      budgets: {
        maxRounds: input.input.max_rounds,
        maxWallTimeMinutes: input.input.max_wall_time_minutes,
        maxNoProgressRounds: input.input.max_no_progress_rounds,
        maxSameFailure: input.input.max_same_failure,
      },
    });
    return goalResponse(`Started ${goal.id}.`, goal);
  }

  if (action === "attach") {
    const goalId = required(input.input.goal_id, "goal_id", action);
    const scope = required(conversationScopeId, "openai/session metadata", action);
    const existing = goalStore.requireGoal(goalId);
    await workspaces.getWorkspace(existing.workspaceSessionId);
    let attached = goalStore.attachConversation(goalId, scope);
    if (input.input.resume_nonce) {
      attached = goalStore.acknowledgeContinuation({
        goalId,
        nonce: input.input.resume_nonce,
        conversationScopeId: scope,
      });
    }
    return goalResponse(`Attached this conversation to ${goalId}.`, attached);
  }

  let goal = resolveGoal(goalStore, input.input.goal_id, conversationScopeId);
  if (input.input.resume_nonce) {
    goal = goalStore.acknowledgeContinuation({
      goalId: goal.id,
      nonce: input.input.resume_nonce,
      conversationScopeId,
    });
  }

  if (action === "status") return goalResponse(goalStatusText(goal), goal);
  if (action === "history") {
    const events = goalStore.listEvents(goal.id, input.input.history_limit ?? 20);
    return {
      content: [textBlock(`Loaded ${events.length} durable event(s) for ${goal.id}.`)],
      structuredContent: {
        result: `Loaded ${events.length} durable event(s) for ${goal.id}.`,
        goal: serializeGoal(goal),
        events: events.map((event) => ({
          id: event.id,
          kind: event.kind,
          round_number: event.roundNumber,
          payload: event.payload,
          created_at: event.createdAt,
        })),
      },
    };
  }
  if (action === "update" || action === "checkpoint") {
    const updated = goalStore.updateGoal({
      goalId: goal.id,
      summary: input.input.summary,
      currentStep: input.input.current_step,
      nextStep: input.input.next_step,
      resumeCapsule: normalizeResumeCapsule(input.input.resume_capsule),
      eventKind: action === "checkpoint" ? "checkpoint" : input.input.event_kind,
      eventPayload: input.input.event_note ? { note: input.input.event_note } : undefined,
    });
    return goalResponse(action === "checkpoint" ? `Checkpointed ${goal.id}.` : `Updated ${goal.id}.`, updated);
  }
  if (action === "verify") {
    const updates = required(input.input.criterion_updates, "criterion_updates", action)
      .map(normalizeCriterionUpdate);
    return goalResponse(`Verified ${updates.length} criterion/criteria for ${goal.id}.`, goalStore.verifyCriteria(goal.id, updates));
  }
  if (action === "finish") {
    try {
      return goalResponse(`Goal ${goal.id} succeeded.`, goalStore.finishGoal(goal.id));
    } catch (error) {
      if (!(error instanceof GoalNotCompleteError)) throw error;
      const remaining = error.remainingCriteria.map((criterion) => criterion.id);
      const message = `GOAL_NOT_COMPLETE: ${remaining.join(", ")}`;
      return {
        isError: true,
        content: [textBlock(message)],
        structuredContent: {
          result: message,
          goal: serializeGoal(goalStore.requireGoal(goal.id)),
          error_code: error.code,
          remaining_criteria: remaining,
        },
      };
    }
  }

  const transitions: Partial<Record<typeof action, { status: GoalStatus; event: string }>> = {
    pause: { status: "paused", event: "goal_paused" },
    request_approval: { status: "waiting_approval", event: "approval_requested" },
    block: { status: "blocked", event: "blocked" },
    fail: { status: "failed", event: "goal_failed" },
    cancel: { status: "cancelled", event: "goal_cancelled" },
  };
  if (action === "resume") {
    if (goal.status === "waiting_approval") {
      throw new Error(`Goal ${goal.id} is waiting for approval; use action=approve instead of resume.`);
    }
    return goalResponse(`Resumed ${goal.id}.`, goalStore.updateGoal({
      goalId: goal.id,
      status: "running",
      eventKind: "goal_resumed",
    }));
  }
  if (action === "approve") {
    if (goal.status !== "waiting_approval") {
      throw new Error(`Goal ${goal.id} is not waiting for approval.`);
    }
    return goalResponse(`Approved ${goal.id}.`, goalStore.updateGoal({
      goalId: goal.id,
      status: "running",
      eventKind: "approval_granted",
    }));
  }
  const transition = transitions[action];
  if (transition) {
    return goalResponse(`${transition.status} ${goal.id}.`, goalStore.updateGoal({
      goalId: goal.id,
      status: transition.status,
      summary: input.input.summary,
      currentStep: input.input.current_step,
      nextStep: input.input.next_step,
      resumeCapsule: normalizeResumeCapsule(input.input.resume_capsule),
      eventKind: transition.event,
      eventPayload: input.input.event_note ? { note: input.input.event_note } : undefined,
    }));
  }

  throw new Error(`Unsupported goal action: ${action}`);
}

function resolveGoal(goalStore: GoalStore, goalId: string | undefined, conversationScopeId: string | undefined): PersistentGoal {
  if (goalId) return goalStore.requireGoal(goalId);
  if (conversationScopeId) {
    const goal = goalStore.getGoalForConversation(conversationScopeId);
    if (goal) return goal;
  }
  throw new Error("goal_id is required because this conversation is not attached to a Goal.");
}

function goalResponse(message: string, goal: PersistentGoal) {
  return {
    content: [textBlock(`${message}\n${goalStatusText(goal)}`)],
    structuredContent: {
      result: message,
      goal: serializeGoal(goal),
    },
  };
}

function goalStatusText(goal: PersistentGoal): string {
  const requiredCriteria = goal.criteria.filter((criterion) => criterion.required);
  const remaining = goal.criteria.filter((criterion) => criterion.required && criterion.status !== "passed");
  return `Goal ${goal.id}: ${goal.status}; required criteria ${requiredCriteria.length - remaining.length}/${requiredCriteria.length}; round ${goal.roundNumber}.`;
}

function serializeGoal(goal: PersistentGoal) {
  return {
    goal_id: goal.id,
    workspace_id: goal.workspaceSessionId,
    objective: goal.objective,
    status: goal.status,
    summary: goal.summary,
    current_step: goal.currentStep,
    next_step: goal.nextStep,
    round_number: goal.roundNumber,
    constraints: goal.constraints,
    criteria: goal.criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      required: criterion.required,
      status: criterion.status,
      evidence: criterion.evidence,
      verification_source: criterion.verificationSource,
      verification_time: criterion.verificationTime,
    })),
    remaining_required: goal.criteria
      .filter((criterion) => criterion.required && criterion.status !== "passed")
      .map((criterion) => criterion.id),
    resume_capsule: denormalizeResumeCapsule(goal.resumeCapsule),
    budgets: {
      max_rounds: goal.budgets.maxRounds,
      max_wall_time_minutes: goal.budgets.maxWallTimeMinutes,
      max_no_progress_rounds: goal.budgets.maxNoProgressRounds,
      max_same_failure: goal.budgets.maxSameFailure,
    },
    updated_at: goal.updatedAt,
  };
}

function normalizeResumeCapsule(value: z.infer<typeof resumeCapsuleSchema> | undefined): GoalResumeCapsule | undefined {
  if (!value) return undefined;
  const capsule = {
    objective: value.objective,
    completed: value.completed,
    remaining: value.remaining,
    hardConstraints: value.hard_constraints,
    decisions: value.decisions,
    currentState: value.current_state,
    workCompleted: value.work_completed,
    currentProblem: value.current_problem,
    nextActions: value.next_actions,
    failures: value.failures,
    evidence: value.evidence,
  };
  if (JSON.stringify(capsule).length > MAX_RESUME_CAPSULE_CHARS) {
    throw new Error(`resume_capsule exceeds the ${MAX_RESUME_CAPSULE_CHARS}-character Goal recovery budget.`);
  }
  return capsule;
}

function denormalizeResumeCapsule(value: GoalResumeCapsule) {
  return {
    objective: value.objective,
    completed: value.completed,
    remaining: value.remaining,
    hard_constraints: value.hardConstraints,
    decisions: value.decisions,
    current_state: value.currentState,
    work_completed: value.workCompleted,
    current_problem: value.currentProblem,
    next_actions: value.nextActions,
    failures: value.failures,
    evidence: value.evidence,
  };
}

function normalizeCriterionUpdate(value: z.infer<typeof criterionUpdateSchema>): GoalCriterionUpdate {
  return {
    id: value.id,
    status: value.status,
    evidence: value.evidence?.map((evidence): GoalEvidence => evidence),
    verificationSource: value.verification_source,
  };
}

function required<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined) throw new Error(`${field} is required for goal action=${action}.`);
  return value;
}
