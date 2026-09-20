import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  goalConversationBindings,
  goalCriteria,
  goalEvents,
  goals,
  type GoalCriterionRow,
  type GoalEventRow,
  type GoalRow,
} from "./db/schema.js";

export type GoalStatus =
  | "planning"
  | "running"
  | "verifying"
  | "waiting_approval"
  | "blocked"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export type GoalCriterionStatus = "pending" | "passed" | "failed" | "blocked";

export interface GoalEvidence {
  kind: string;
  summary: string;
  ref?: string;
}

export interface GoalResumeCapsule {
  objective?: string;
  completed?: string[];
  remaining?: string[];
  hardConstraints?: string[];
  decisions?: string[];
  currentState?: string;
  workCompleted?: string[];
  currentProblem?: string;
  nextActions?: string[];
  failures?: string[];
  evidence?: string[];
}

export interface GoalCriterion {
  id: string;
  description: string;
  required: boolean;
  status: GoalCriterionStatus;
  evidence: GoalEvidence[];
  verificationSource?: string;
  verificationTime?: string;
  updatedAt: string;
}

export interface GoalBudgets {
  maxRounds: number;
  maxWallTimeMinutes: number;
  maxNoProgressRounds: number;
  maxSameFailure: number;
}

export interface PersistentGoal {
  id: string;
  workspaceSessionId: string;
  objective: string;
  status: GoalStatus;
  constraints: string[];
  resumeCapsule: GoalResumeCapsule;
  summary: string;
  currentStep?: string;
  nextStep?: string;
  roundNumber: number;
  budgets: GoalBudgets;
  leaseOwner?: string;
  leaseUntil?: string;
  pendingResume: boolean;
  lastResumeNonce?: string;
  createdAt: string;
  updatedAt: string;
  criteria: GoalCriterion[];
}

export interface GoalEvent {
  id: number;
  goalId: string;
  kind: string;
  roundNumber: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface GoalCriterionInput {
  id: string;
  description: string;
  required?: boolean;
}

export interface GoalCriterionUpdate {
  id: string;
  status: GoalCriterionStatus;
  evidence?: GoalEvidence[];
  verificationSource?: string;
}

const TERMINAL_GOAL_STATUSES = new Set<GoalStatus>(["succeeded", "failed", "cancelled"]);

export class GoalStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createGoal(input: {
    workspaceSessionId: string;
    objective: string;
    criteria: GoalCriterionInput[];
    constraints?: string[];
    conversationScopeId?: string;
    summary?: string;
    nextStep?: string;
    budgets?: Partial<GoalBudgets>;
  }): PersistentGoal {
    const criterionIds = input.criteria.map((criterion) => criterion.id);
    if (new Set(criterionIds).size !== criterionIds.length) {
      throw new Error("Goal criteria ids must be unique.");
    }
    const now = new Date().toISOString();
    const goalId = `goal_${randomUUID().replaceAll("-", "")}`;
    const budgets: GoalBudgets = {
      maxRounds: input.budgets?.maxRounds ?? 80,
      maxWallTimeMinutes: input.budgets?.maxWallTimeMinutes ?? 720,
      maxNoProgressRounds: input.budgets?.maxNoProgressRounds ?? 4,
      maxSameFailure: input.budgets?.maxSameFailure ?? 3,
    };

    const transaction = this.database.sqlite.transaction(() => {
      this.database.db.insert(goals).values({
        id: goalId,
        workspaceSessionId: input.workspaceSessionId,
        objective: input.objective,
        status: "running",
        constraintsJson: JSON.stringify(input.constraints ?? []),
        resumeCapsuleJson: JSON.stringify({
          objective: input.objective,
          hardConstraints: input.constraints ?? [],
          remaining: input.criteria.filter((criterion) => criterion.required !== false).map((criterion) => criterion.id),
        } satisfies GoalResumeCapsule),
        summary: input.summary ?? "",
        nextStep: input.nextStep ?? null,
        roundNumber: 0,
        maxRounds: budgets.maxRounds,
        maxWallTimeMinutes: budgets.maxWallTimeMinutes,
        maxNoProgressRounds: budgets.maxNoProgressRounds,
        maxSameFailure: budgets.maxSameFailure,
        createdAt: now,
        updatedAt: now,
      }).run();

      for (const criterion of input.criteria) {
        this.database.db.insert(goalCriteria).values({
          goalId,
          criterionId: criterion.id,
          description: criterion.description,
          required: String(criterion.required !== false),
          status: "pending",
          evidenceJson: "[]",
          updatedAt: now,
        }).run();
      }

      if (input.conversationScopeId) {
        this.setConversationBinding(goalId, input.conversationScopeId, now);
      }

      this.insertEvent(goalId, "goal_started", 0, {
        criteria: input.criteria.map((criterion) => criterion.id),
      }, now);
    });
    transaction.immediate();

    return this.requireGoal(goalId);
  }

  getGoal(goalId: string): PersistentGoal | undefined {
    const row = this.database.db.select().from(goals).where(eq(goals.id, goalId)).get();
    if (!row) return undefined;
    const criteriaRows = this.database.db
      .select()
      .from(goalCriteria)
      .where(eq(goalCriteria.goalId, goalId))
      .all();
    return rowToGoal(row, criteriaRows);
  }

  requireGoal(goalId: string): PersistentGoal {
    const goal = this.getGoal(goalId);
    if (!goal) throw new Error(`Unknown goal: ${goalId}`);
    return goal;
  }

  getGoalForConversation(conversationScopeId: string): PersistentGoal | undefined {
    const binding = this.database.db
      .select()
      .from(goalConversationBindings)
      .where(eq(goalConversationBindings.conversationScopeId, conversationScopeId))
      .get();
    if (!binding) return undefined;
    this.database.db.update(goalConversationBindings)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(goalConversationBindings.conversationScopeId, conversationScopeId))
      .run();
    return this.getGoal(binding.goalId);
  }

  attachConversation(goalId: string, conversationScopeId: string): PersistentGoal {
    const goal = this.requireGoal(goalId);
    const now = new Date().toISOString();
    this.setConversationBinding(goalId, conversationScopeId, now);
    this.insertEvent(goalId, "conversation_attached", goal.roundNumber, {}, now);
    return this.requireGoal(goalId);
  }

  updateGoal(input: {
    goalId: string;
    status?: GoalStatus;
    summary?: string;
    currentStep?: string | null;
    nextStep?: string | null;
    resumeCapsule?: GoalResumeCapsule;
    roundNumber?: number;
    eventKind?: string;
    eventPayload?: Record<string, unknown>;
  }): PersistentGoal {
    const current = this.requireGoal(input.goalId);
    if (input.status && input.status !== current.status) {
      assertGoalTransition(current.status, input.status);
    }
    const now = new Date().toISOString();
    this.database.db.update(goals).set({
      ...(input.status ? { status: input.status } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.currentStep !== undefined ? { currentStep: input.currentStep } : {}),
      ...(input.nextStep !== undefined ? { nextStep: input.nextStep } : {}),
      ...(input.resumeCapsule !== undefined
        ? { resumeCapsuleJson: JSON.stringify(input.resumeCapsule) }
        : {}),
      ...(input.roundNumber !== undefined ? { roundNumber: input.roundNumber } : {}),
      updatedAt: now,
    }).where(eq(goals.id, input.goalId)).run();

    if (input.eventKind) {
      this.insertEvent(
        input.goalId,
        input.eventKind,
        input.roundNumber ?? current.roundNumber,
        input.eventPayload ?? {},
        now,
      );
    }
    return this.requireGoal(input.goalId);
  }

  verifyCriteria(goalId: string, updates: GoalCriterionUpdate[]): PersistentGoal {
    const goal = this.requireGoal(goalId);
    if (goal.status !== "running" && goal.status !== "verifying") {
      throw new Error(`Goal ${goalId} cannot verify criteria while ${goal.status}.`);
    }
    const known = new Set(goal.criteria.map((criterion) => criterion.id));
    for (const update of updates) {
      if (!known.has(update.id)) throw new Error(`Unknown goal criterion: ${update.id}`);
    }

    const now = new Date().toISOString();
    const transaction = this.database.sqlite.transaction(() => {
      for (const update of updates) {
        this.database.db.update(goalCriteria).set({
          status: update.status,
          ...(update.evidence !== undefined
            ? { evidenceJson: JSON.stringify(update.evidence) }
            : {}),
          ...(update.verificationSource !== undefined
            ? { verificationSource: update.verificationSource }
            : {}),
          verificationTime: now,
          updatedAt: now,
        }).where(and(
          eq(goalCriteria.goalId, goalId),
          eq(goalCriteria.criterionId, update.id),
        )).run();
      }
      this.database.db.update(goals).set({ status: "verifying", updatedAt: now })
        .where(eq(goals.id, goalId)).run();
      this.insertEvent(goalId, "verification", goal.roundNumber, {
        criteria: updates.map((update) => ({ id: update.id, status: update.status })),
      }, now);
    });
    transaction.immediate();
    return this.requireGoal(goalId);
  }

  finishGoal(goalId: string): PersistentGoal {
    const goal = this.requireGoal(goalId);
    if (TERMINAL_GOAL_STATUSES.has(goal.status)) {
      if (goal.status === "succeeded") return goal;
      throw new Error(`Goal ${goalId} cannot finish from terminal status ${goal.status}.`);
    }
    const remaining = goal.criteria.filter((criterion) => criterion.required && criterion.status !== "passed");
    if (remaining.length > 0) {
      throw new GoalNotCompleteError(goalId, remaining);
    }
    if (goal.status !== "verifying") {
      throw new Error(`Goal ${goalId} must be verifying before it can finish.`);
    }
    const now = new Date().toISOString();
    this.database.db.update(goals).set({
      status: "succeeded",
      pendingResume: "false",
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
    }).where(eq(goals.id, goalId)).run();
    this.insertEvent(goalId, "goal_completed", goal.roundNumber, {}, now);
    return this.requireGoal(goalId);
  }

  listEvents(goalId: string, limit = 20): GoalEvent[] {
    this.requireGoal(goalId);
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.database.db.select().from(goalEvents)
      .where(eq(goalEvents.goalId, goalId))
      .orderBy(desc(goalEvents.id))
      .limit(safeLimit)
      .all()
      .reverse()
      .map(rowToGoalEvent);
  }

  close(): void {
    this.database.close();
  }

  private setConversationBinding(goalId: string, conversationScopeId: string, now: string): void {
    this.database.db.insert(goalConversationBindings).values({
      conversationScopeId,
      goalId,
      createdAt: now,
      lastUsedAt: now,
    }).onConflictDoUpdate({
      target: goalConversationBindings.conversationScopeId,
      set: { goalId, lastUsedAt: now },
    }).run();
  }

  private insertEvent(
    goalId: string,
    kind: string,
    roundNumber: number,
    payload: Record<string, unknown>,
    createdAt: string,
  ): void {
    this.database.db.insert(goalEvents).values({
      goalId,
      kind,
      roundNumber,
      payloadJson: JSON.stringify(payload),
      createdAt,
    }).run();
  }
}

export class GoalNotCompleteError extends Error {
  readonly code = "GOAL_NOT_COMPLETE";

  constructor(
    readonly goalId: string,
    readonly remainingCriteria: GoalCriterion[],
  ) {
    super(
      `Goal ${goalId} is not complete. Remaining required criteria: ${remainingCriteria
        .map((criterion) => criterion.id)
        .join(", ")}.`,
    );
    this.name = "GoalNotCompleteError";
  }
}

function rowToGoal(row: GoalRow, criteriaRows: GoalCriterionRow[]): PersistentGoal {
  return {
    id: row.id,
    workspaceSessionId: row.workspaceSessionId,
    objective: row.objective,
    status: readGoalStatus(row.status),
    constraints: parseStringArray(row.constraintsJson),
    resumeCapsule: parseJsonObject(row.resumeCapsuleJson) as GoalResumeCapsule,
    summary: row.summary,
    currentStep: row.currentStep ?? undefined,
    nextStep: row.nextStep ?? undefined,
    roundNumber: row.roundNumber,
    budgets: {
      maxRounds: row.maxRounds,
      maxWallTimeMinutes: row.maxWallTimeMinutes,
      maxNoProgressRounds: row.maxNoProgressRounds,
      maxSameFailure: row.maxSameFailure,
    },
    leaseOwner: row.leaseOwner ?? undefined,
    leaseUntil: row.leaseUntil ?? undefined,
    pendingResume: row.pendingResume === "true",
    lastResumeNonce: row.lastResumeNonce ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    criteria: criteriaRows.map(rowToGoalCriterion),
  };
}

function rowToGoalCriterion(row: GoalCriterionRow): GoalCriterion {
  return {
    id: row.criterionId,
    description: row.description,
    required: row.required === "true",
    status: readCriterionStatus(row.status),
    evidence: parseJsonArray(row.evidenceJson) as GoalEvidence[],
    verificationSource: row.verificationSource ?? undefined,
    verificationTime: row.verificationTime ?? undefined,
    updatedAt: row.updatedAt,
  };
}

function rowToGoalEvent(row: GoalEventRow): GoalEvent {
  return {
    id: row.id,
    goalId: row.goalId,
    kind: row.kind,
    roundNumber: row.roundNumber,
    payload: parseJsonObject(row.payloadJson),
    createdAt: row.createdAt,
  };
}

function readGoalStatus(status: string): GoalStatus {
  if (
    status === "planning"
    || status === "running"
    || status === "verifying"
    || status === "waiting_approval"
    || status === "blocked"
    || status === "paused"
    || status === "succeeded"
    || status === "failed"
    || status === "cancelled"
  ) return status;
  throw new Error(`Unknown goal status: ${status}`);
}

function readCriterionStatus(status: string): GoalCriterionStatus {
  if (status === "pending" || status === "passed" || status === "failed" || status === "blocked") {
    return status;
  }
  throw new Error(`Unknown goal criterion status: ${status}`);
}

function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  const allowed: Record<GoalStatus, ReadonlySet<GoalStatus>> = {
    planning: new Set(["running", "paused", "cancelled", "failed"]),
    running: new Set(["verifying", "waiting_approval", "blocked", "paused", "cancelled", "failed"]),
    verifying: new Set(["running", "waiting_approval", "blocked", "paused", "succeeded", "cancelled", "failed"]),
    waiting_approval: new Set(["running", "paused", "cancelled", "failed"]),
    blocked: new Set(["running", "paused", "cancelled", "failed"]),
    paused: new Set(["running", "cancelled", "failed"]),
    succeeded: new Set(),
    failed: new Set(),
    cancelled: new Set(),
  };
  if (!allowed[from].has(to)) throw new Error(`Invalid goal status transition: ${from} -> ${to}`);
}

function parseJsonArray(value: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Stored goal JSON value is not an array.");
  return parsed;
}

function parseStringArray(value: string): string[] {
  const parsed = parseJsonArray(value);
  if (parsed.some((item) => typeof item !== "string")) {
    throw new Error("Stored goal JSON value is not a string array.");
  }
  return parsed as string[];
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored goal JSON value is not an object.");
  }
  return parsed as Record<string, unknown>;
}
