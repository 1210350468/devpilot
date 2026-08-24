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

  private pruneSessionBindings(): void {
    if (this.conversationByMcpSession.size <= this.limit) return;
    const activeSessions = new Set(this.entries.map((entry) => entry.mcpSessionId).filter((value): value is string => Boolean(value)));
    for (const sessionId of this.conversationByMcpSession.keys()) {
      if (!activeSessions.has(sessionId)) this.conversationByMcpSession.delete(sessionId);
    }
  }
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
