import type { GoalBrowserAdapter, GoalWatchdogOutcome } from "./goal-watchdog.js";
import { GoalContinuationWatchdog } from "./goal-watchdog.js";
import type { GoalStore } from "./goal-store.js";

export type GoalWatchdogServiceState = "idle" | "running" | "waiting_browser" | "stopped";

export interface GoalWatchdogServiceSnapshot {
  state: GoalWatchdogServiceState;
  activeGoals: number;
  lastTickAt?: string;
  lastError?: string;
  lastOutcomes: GoalWatchdogOutcome[];
}

export interface GoalWatchdogServiceOptions {
  intervalMs?: number;
  browserRetryMs?: number;
  browserFactory: () => GoalBrowserAdapter;
  onOutcomes?: (outcomes: readonly GoalWatchdogOutcome[]) => void;
}

/**
 * Arms the Goal continuation watchdog only while durable Goals are continuable. The service owns
 * no reasoning loop: each tick only observes ChatGPT transport state and, when policy allows it,
 * sends the compact prompt that starts the next host-GPT turn.
 */
export class GoalWatchdogService {
  private readonly intervalMs: number;
  private readonly browserRetryMs: number;
  private browser?: GoalBrowserAdapter;
  private watchdog?: GoalContinuationWatchdog;
  private timer?: NodeJS.Timeout;
  private tickPromise?: Promise<void>;
  private stopping = false;
  private current: GoalWatchdogServiceSnapshot = {
    state: "idle",
    activeGoals: 0,
    lastOutcomes: [],
  };

  constructor(
    private readonly goalStore: GoalStore,
    private readonly options: GoalWatchdogServiceOptions,
  ) {
    this.intervalMs = boundedDelay(options.intervalMs, 1_500);
    this.browserRetryMs = boundedDelay(options.browserRetryMs, 5_000);
  }

  /** Wake the service after a Goal mutation or at runtime startup. */
  notify(): void {
    if (this.stopping) return;
    const activeGoals = this.goalStore.listContinuableGoals().length;
    this.current = { ...this.current, activeGoals };
    if (activeGoals === 0) {
      this.clearTimer();
      this.current = { ...this.current, state: "idle", lastError: undefined, lastOutcomes: [] };
      return;
    }
    if (!this.timer && !this.tickPromise) this.schedule(0);
  }

  snapshot(): GoalWatchdogServiceSnapshot {
    return {
      ...this.current,
      lastOutcomes: [...this.current.lastOutcomes],
    };
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      await this.tickPromise;
      return;
    }
    this.stopping = true;
    this.clearTimer();
    await this.tickPromise;
    this.current = {
      ...this.current,
      state: "stopped",
      activeGoals: 0,
      lastOutcomes: [],
    };
  }

  private schedule(delayMs: number): void {
    if (this.stopping || this.timer || this.tickPromise) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const tick = this.runTick();
      this.tickPromise = tick;
      void tick.finally(() => {
        if (this.tickPromise === tick) this.tickPromise = undefined;
        if (this.stopping) return;
        const activeGoals = this.goalStore.listContinuableGoals().length;
        this.current = { ...this.current, activeGoals };
        if (activeGoals === 0) {
          this.current = { ...this.current, state: "idle", lastError: undefined, lastOutcomes: [] };
          return;
        }
        const retry = this.current.state === "waiting_browser" ? this.browserRetryMs : this.intervalMs;
        this.schedule(retry);
      });
    }, Math.max(0, delayMs));
    this.timer.unref();
  }

  private async runTick(): Promise<void> {
    const activeGoals = this.goalStore.listContinuableGoals().length;
    if (activeGoals === 0) {
      this.current = { ...this.current, state: "idle", activeGoals: 0, lastOutcomes: [] };
      return;
    }

    let watchdog: GoalContinuationWatchdog;
    try {
      watchdog = this.ensureWatchdog();
    } catch (error) {
      this.current = {
        ...this.current,
        state: "waiting_browser",
        activeGoals,
        lastTickAt: new Date().toISOString(),
        lastError: errorMessage(error),
        lastOutcomes: [],
      };
      return;
    }

    try {
      const outcomes = await watchdog.tick();
      const browserUnavailable = outcomes.find((outcome) => outcome.kind === "browser_unavailable");
      this.current = {
        state: browserUnavailable ? "waiting_browser" : "running",
        activeGoals,
        lastTickAt: new Date().toISOString(),
        lastError: browserUnavailable?.kind === "browser_unavailable"
          ? browserUnavailable.detail ?? browserUnavailable.state
          : undefined,
        lastOutcomes: outcomes,
      };
      this.options.onOutcomes?.(outcomes);
    } catch (error) {
      this.current = {
        ...this.current,
        state: "waiting_browser",
        activeGoals,
        lastTickAt: new Date().toISOString(),
        lastError: errorMessage(error),
        lastOutcomes: [],
      };
    }
  }

  private ensureWatchdog(): GoalContinuationWatchdog {
    if (this.watchdog) return this.watchdog;
    this.browser = this.options.browserFactory();
    this.watchdog = new GoalContinuationWatchdog(this.goalStore, this.browser);
    return this.watchdog;
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function boundedDelay(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 10 || value > 300_000) {
    throw new Error("Goal watchdog delays must be between 10ms and 300000ms.");
  }
  return Math.floor(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
