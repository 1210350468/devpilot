export interface ObservedRequest {
  id: string;
  startedAt: string;
  completedAt?: string;
  method: string;
  path: string;
  status?: number;
  durationMs?: number;
  host?: string;
  userAgent?: string;
  mcpMethod?: string;
  toolName?: string;
  paramsPreview?: string;
  responsePreview?: string;
  conversationScopeId?: string;
  mcpSessionId?: string;
}

export interface ObservedConversation {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
  requestCount: number;
  toolCallCount: number;
  runningCount: number;
  lastToolName?: string;
}

export type RequestDiagnosticState = "quiet" | "healthy" | "busy" | "slow" | "error";

export interface RequestDiagnosticItem {
  id: string;
  startedAt: string;
  completedAt?: string;
  toolName?: string;
  mcpMethod?: string;
  status?: number;
  durationMs?: number;
  elapsedMs: number;
  conversationScopeId?: string;
}

export interface RequestDiagnostics {
  generatedAt: string;
  windowMs: number;
  slowThresholdMs: number;
  verySlowThresholdMs: number;
  state: RequestDiagnosticState;
  receivedCount: number;
  completedCount: number;
  runningCount: number;
  failedCount: number;
  slowCount: number;
  verySlowCount: number;
  p95DurationMs?: number;
  maxDurationMs?: number;
  latestRequestAt?: string;
  latestCompletedAt?: string;
  oldestRunning?: RequestDiagnosticItem;
  recentSlow: RequestDiagnosticItem[];
}

export interface RequestDiagnosticsOptions {
  windowMs?: number;
  slowThresholdMs?: number;
  verySlowThresholdMs?: number;
  nowMs?: number;
}

export class RequestObserver {
  private readonly entries: ObservedRequest[] = [];
  private readonly conversationByMcpSession = new Map<string, string>();
  private readonly limit: number;

  constructor(limit = 200) {
    this.limit = limit;
  }

  start(entry: Omit<ObservedRequest, "completedAt" | "status" | "durationMs">): void {
    const explicitConversation = entry.conversationScopeId?.trim() || undefined;
    const sessionId = entry.mcpSessionId?.trim() || undefined;
    if (explicitConversation && sessionId) {
      this.conversationByMcpSession.set(sessionId, explicitConversation);
    }
    const conversationScopeId = explicitConversation
      ?? (sessionId ? this.conversationByMcpSession.get(sessionId) : undefined);

    this.entries.unshift({ ...entry, conversationScopeId });
    if (this.entries.length > this.limit) this.entries.length = this.limit;
    this.pruneSessionBindings();
  }

  finish(id: string, patch: Pick<ObservedRequest, "completedAt" | "status" | "durationMs" | "responsePreview">): void {
    const entry = this.entries.find((item) => item.id === id);
    if (entry) Object.assign(entry, patch);
  }

  list(limit = 100, conversationScopeId?: string): ObservedRequest[] {
    const filtered = conversationScopeId
      ? this.entries.filter((entry) => entry.conversationScopeId === conversationScopeId)
      : this.entries;
    return filtered.slice(0, Math.max(1, Math.min(limit, this.limit)));
  }

  conversations(): ObservedConversation[] {
    const grouped = new Map<string, ObservedConversation>();
    for (const entry of this.entries) {
      if (!entry.conversationScopeId) continue;
      const current = grouped.get(entry.conversationScopeId);
      if (!current) {
        grouped.set(entry.conversationScopeId, {
          id: entry.conversationScopeId,
          firstSeenAt: entry.startedAt,
          lastSeenAt: entry.startedAt,
          requestCount: 1,
          toolCallCount: entry.toolName ? 1 : 0,
          runningCount: entry.status === undefined ? 1 : 0,
          lastToolName: entry.toolName,
        });
        continue;
      }
      current.requestCount += 1;
      if (entry.toolName) {
        current.toolCallCount += 1;
        current.lastToolName ??= entry.toolName;
      }
      if (entry.status === undefined) current.runningCount += 1;
      if (entry.startedAt < current.firstSeenAt) current.firstSeenAt = entry.startedAt;
      if (entry.startedAt > current.lastSeenAt) {
        current.lastSeenAt = entry.startedAt;
        current.lastToolName = entry.toolName ?? current.lastToolName;
      }
    }
    return Array.from(grouped.values()).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  diagnostics(options: RequestDiagnosticsOptions = {}): RequestDiagnostics {
    const nowMs = options.nowMs ?? Date.now();
    const windowMs = options.windowMs ?? 5 * 60_000;
    const slowThresholdMs = options.slowThresholdMs ?? 5_000;
    const verySlowThresholdMs = options.verySlowThresholdMs ?? 15_000;
    const cutoffMs = nowMs - windowMs;
    const recent = this.entries.filter((entry) => {
      if (entry.path !== "/mcp" || !entry.mcpMethod) return false;
      const startedMs = Date.parse(entry.startedAt);
      return Number.isFinite(startedMs) && startedMs >= cutoffMs;
    });
    const completed = recent.filter((entry) => entry.status !== undefined && entry.durationMs !== undefined);
    const running = recent.filter((entry) => entry.status === undefined);
    const failed = completed.filter((entry) => (entry.status ?? 0) >= 400);
    const diagnosticItems = recent.map((entry) => toDiagnosticItem(entry, nowMs));
    const slow = diagnosticItems.filter((entry) => entry.elapsedMs >= slowThresholdMs);
    const verySlow = diagnosticItems.filter((entry) => entry.elapsedMs >= verySlowThresholdMs);
    const durations = completed
      .map((entry) => entry.durationMs!)
      .sort((a, b) => a - b);
    const runningItems = diagnosticItems
      .filter((entry) => entry.status === undefined)
      .sort((a, b) => b.elapsedMs - a.elapsedMs);
    const recentSlow = slow
      .sort((a, b) => b.elapsedMs - a.elapsedMs)
      .slice(0, 8);
    const state: RequestDiagnosticState = failed.length > 0
      ? "error"
      : slow.length > 0
        ? "slow"
        : running.length > 0
          ? "busy"
          : recent.length > 0
            ? "healthy"
            : "quiet";

    return {
      generatedAt: new Date(nowMs).toISOString(),
      windowMs,
      slowThresholdMs,
      verySlowThresholdMs,
      state,
      receivedCount: recent.length,
      completedCount: completed.length,
      runningCount: running.length,
      failedCount: failed.length,
      slowCount: slow.length,
      verySlowCount: verySlow.length,
      p95DurationMs: percentile95(durations),
      maxDurationMs: durations.length > 0 ? durations[durations.length - 1] : undefined,
      latestRequestAt: latestIso(recent.map((entry) => entry.startedAt)),
      latestCompletedAt: latestIso(recent.map((entry) => entry.completedAt).filter((value): value is string => Boolean(value))),
      oldestRunning: runningItems[0],
      recentSlow,
    };
  }

  private pruneSessionBindings(): void {
    if (this.conversationByMcpSession.size <= this.limit) return;
    const activeSessions = new Set(
      this.entries
        .map((entry) => entry.mcpSessionId)
        .filter((value): value is string => Boolean(value)),
    );
    for (const sessionId of this.conversationByMcpSession.keys()) {
      if (!activeSessions.has(sessionId)) this.conversationByMcpSession.delete(sessionId);
    }
  }
}

function toDiagnosticItem(entry: ObservedRequest, nowMs: number): RequestDiagnosticItem {
  const startedMs = Date.parse(entry.startedAt);
  const elapsedMs = entry.durationMs ?? Math.max(0, nowMs - startedMs);
  return {
    id: entry.id,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    toolName: entry.toolName,
    mcpMethod: entry.mcpMethod,
    status: entry.status,
    durationMs: entry.durationMs,
    elapsedMs,
    conversationScopeId: entry.conversationScopeId,
  };
}

function percentile95(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const index = Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1);
  return values[index];
}

function latestIso(values: string[]): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || parsed <= latestMs) continue;
    latest = value;
    latestMs = parsed;
  }
  return latest;
}

export function previewJson(value: unknown, max = 600): string | undefined {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
  } catch {
    return String(value).slice(0, max);
  }
}
