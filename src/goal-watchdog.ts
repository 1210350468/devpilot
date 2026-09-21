import { randomBytes } from "node:crypto";
import type {
  GoalBrowserBinding,
  GoalContinuationDecision,
  GoalStore,
  PersistentGoal,
} from "./goal-store.js";

export type GoalBrowserPageState =
  | "generating"
  | "idle"
  | "disconnected"
  | "login_required"
  | "rate_limited"
  | "conversation_limit"
  | "error";

export interface GoalBrowserSnapshot {
  state: GoalBrowserPageState;
  conversationUrl?: string;
  conversationKey?: string;
  detail?: string;
}

export interface GoalBrowserSendResult {
  conversationUrl?: string;
  conversationKey?: string;
}

export interface GoalBrowserAdapter {
  readonly id: string;
  inspect(input: {
    goal: PersistentGoal;
    binding?: GoalBrowserBinding;
  }): Promise<GoalBrowserSnapshot>;
  sendContinuation(input: {
    goal: PersistentGoal;
    binding?: GoalBrowserBinding;
    prompt: string;
    roundNumber: number;
    resumeNonce: string;
  }): Promise<GoalBrowserSendResult>;
  rotateConversation(input: {
    goal: PersistentGoal;
    binding?: GoalBrowserBinding;
    prompt: string;
    roundNumber: number;
    resumeNonce: string;
  }): Promise<GoalBrowserSendResult>;
}

export type GoalWatchdogOutcome =
  | { goalId: string; kind: "sent_continue"; roundNumber: number; resumeNonce: string }
  | { goalId: string; kind: "sent_resume"; roundNumber: number; resumeNonce: string }
  | { goalId: string; kind: "generating" }
  | { goalId: string; kind: "pending_ack" }
  | { goalId: string; kind: "busy" }
  | { goalId: string; kind: "blocked"; reason: string }
  | { goalId: string; kind: "browser_unavailable"; state: GoalBrowserPageState; detail?: string }
  | { goalId: string; kind: "send_failed"; error: string };

export interface GoalWatchdogOptions {
  ownerId?: string;
  leaseMs?: number;
  now?: () => Date;
}

export class GoalContinuationWatchdog {
  readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly goalStore: GoalStore,
    private readonly browser: GoalBrowserAdapter,
    options: GoalWatchdogOptions = {},
  ) {
    this.ownerId = options.ownerId ?? `goal_watchdog_${randomBytes(12).toString("base64url")}`;
    this.leaseMs = Math.max(5_000, Math.min(300_000, Math.floor(options.leaseMs ?? 60_000)));
    this.now = options.now ?? (() => new Date());
  }

  async tick(): Promise<GoalWatchdogOutcome[]> {
    const goals = this.goalStore.listContinuableGoals();
    const outcomes: GoalWatchdogOutcome[] = [];
    for (const goal of goals) {
      outcomes.push(await this.tickGoal(goal));
    }
    return outcomes;
  }

  async tickGoal(initialGoal: PersistentGoal): Promise<GoalWatchdogOutcome> {
    let goal = this.goalStore.requireGoal(initialGoal.id);
    let binding = this.goalStore.getBrowserBinding(goal.id);
    let snapshot: GoalBrowserSnapshot;
    try {
      snapshot = await this.browser.inspect({ goal, binding });
    } catch (error) {
      return {
        goalId: goal.id,
        kind: "browser_unavailable",
        state: "error",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (snapshot.conversationUrl || snapshot.conversationKey) {
      binding = this.goalStore.setBrowserBinding({
        goalId: goal.id,
        adapter: this.browser.id,
        conversationUrl: snapshot.conversationUrl,
        conversationKey: snapshot.conversationKey,
        now: this.now(),
      });
    }

    if (snapshot.state === "generating") return { goalId: goal.id, kind: "generating" };
    if (
      snapshot.state === "disconnected"
      || snapshot.state === "login_required"
      || snapshot.state === "rate_limited"
      || snapshot.state === "error"
    ) {
      return {
        goalId: goal.id,
        kind: "browser_unavailable",
        state: snapshot.state,
        detail: snapshot.detail,
      };
    }

    goal = this.goalStore.requireGoal(goal.id);
    const leaseActive = goal.leaseOwner
      && goal.leaseUntil
      && Date.parse(goal.leaseUntil) > this.now().getTime();
    if (leaseActive) {
      if (goal.leaseOwner !== this.ownerId) return { goalId: goal.id, kind: "busy" };
      if (goal.pendingResume) return { goalId: goal.id, kind: "pending_ack" };
      this.goalStore.releaseContinuation({
        goalId: goal.id,
        leaseOwner: this.ownerId,
        nonce: goal.lastResumeNonce,
        now: this.now(),
      });
      goal = this.goalStore.requireGoal(goal.id);
    }

    const resumeNonce = goal.pendingResume && goal.lastResumeNonce
      ? goal.lastResumeNonce
      : createResumeNonce();
    const decision = this.goalStore.claimContinuation({
      goalId: goal.id,
      leaseOwner: this.ownerId,
      nonce: resumeNonce,
      leaseMs: this.leaseMs,
      now: this.now(),
    });
    if (decision.kind === "busy") return { goalId: goal.id, kind: "busy" };
    if (decision.kind === "stopped") {
      return { goalId: goal.id, kind: "blocked", reason: decision.reason };
    }
    if (decision.kind === "budget_exhausted") {
      return { goalId: goal.id, kind: "blocked", reason: decision.reason };
    }

    // A Goal can be paused/cancelled or moved behind an approval gate after the continuation
    // claim but before browser I/O starts. Re-read durable state so a stale claim never causes one
    // extra ChatGPT message after the user has stopped automatic continuation.
    const sendGuard = this.goalStore.requireGoal(goal.id);
    if (sendGuard.status !== "running" && sendGuard.status !== "verifying") {
      return { goalId: goal.id, kind: "blocked", reason: `status:${sendGuard.status}` };
    }
    if (
      sendGuard.leaseOwner !== this.ownerId
      || sendGuard.lastResumeNonce !== decision.nonce
      || !sendGuard.pendingResume
    ) {
      return { goalId: goal.id, kind: "busy" };
    }

    const rotation = snapshot.state === "conversation_limit";
    const prompt = rotation
      ? goalResumePrompt(decision)
      : goalContinuePrompt(decision);
    try {
      const sent = rotation
        ? await this.browser.rotateConversation({
            goal: decision.goal,
            binding,
            prompt,
            roundNumber: decision.roundNumber,
            resumeNonce: decision.nonce,
          })
        : await this.browser.sendContinuation({
            goal: decision.goal,
            binding,
            prompt,
            roundNumber: decision.roundNumber,
            resumeNonce: decision.nonce,
          });
      if (sent.conversationUrl || sent.conversationKey) {
        this.goalStore.setBrowserBinding({
          goalId: goal.id,
          adapter: this.browser.id,
          conversationUrl: sent.conversationUrl,
          conversationKey: sent.conversationKey,
          rotated: rotation,
          now: this.now(),
        });
      }
      return {
        goalId: goal.id,
        kind: rotation ? "sent_resume" : "sent_continue",
        roundNumber: decision.roundNumber,
        resumeNonce: decision.nonce,
      };
    } catch (error) {
      return {
        goalId: goal.id,
        kind: "send_failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function createResumeNonce(): string {
  return randomBytes(18).toString("base64url");
}

function goalContinuePrompt(decision: Extract<GoalContinuationDecision, { kind: "claimed" }>): string {
  return [
    `GOAL_CONTINUE ${decision.goal.id}`,
    `round=${decision.roundNumber}`,
    `resume_nonce=${decision.nonce}`,
    "",
    "Use DevPilot Goal state as the source of truth.",
    "First acknowledge this continuation by calling goal action=status with goal_id and resume_nonce.",
    "Recover the persisted current step and workspace state through MCP, then continue the work.",
    "Do not restart from scratch and do not use a local model as the Goal reasoning agent.",
    "Continue until the Goal succeeds, becomes blocked, waits for approval, is cancelled, or this ChatGPT turn ends.",
  ].join("\n");
}

function goalResumePrompt(decision: Extract<GoalContinuationDecision, { kind: "claimed" }>): string {
  return [
    `GOAL_RESUME ${decision.goal.id}`,
    `round=${decision.roundNumber}`,
    `resume_nonce=${decision.nonce}`,
    "",
    "This is a continuation of an existing persistent Goal from another ChatGPT conversation.",
    "Call goal action=attach with goal_id and resume_nonce before taking other action.",
    "Load the Resume Capsule and current workspace delta through DevPilot MCP.",
    "Do not reconstruct the task from old chat history and do not restart from scratch.",
    "Continue from the persisted next step until the Goal succeeds, becomes blocked, waits for approval, is cancelled, or this turn ends.",
  ].join("\n");
}
