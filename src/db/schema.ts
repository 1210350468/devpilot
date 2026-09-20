import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    recoveryKind: text("recovery_kind"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const workspaceConversationBindings = sqliteTable(
  "workspace_conversation_bindings",
  {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_conversation_bindings_workspace_idx").on(table.workspaceSessionId),
  ],
);

export const workspaceTaskCheckpoints = sqliteTable(
  "workspace_task_checkpoints",
  {
    workspaceSessionId: text("workspace_session_id")
      .primaryKey()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    summary: text("summary").notNull(),
    nextStep: text("next_step"),
    snapshotRef: text("snapshot_ref"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("workspace_task_checkpoints_updated_idx").on(table.updatedAt),
  ],
);

export const goals = sqliteTable(
  "goals",
  {
    id: text("id").primaryKey(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    objective: text("objective").notNull(),
    status: text("status").notNull().default("planning"),
    constraintsJson: text("constraints_json").notNull().default("[]"),
    resumeCapsuleJson: text("resume_capsule_json").notNull().default("{}"),
    summary: text("summary").notNull().default(""),
    currentStep: text("current_step"),
    nextStep: text("next_step"),
    roundNumber: integer("round_number").notNull().default(0),
    maxRounds: integer("max_rounds").notNull().default(80),
    maxWallTimeMinutes: integer("max_wall_time_minutes").notNull().default(720),
    maxNoProgressRounds: integer("max_no_progress_rounds").notNull().default(4),
    maxSameFailure: integer("max_same_failure").notNull().default(3),
    leaseOwner: text("lease_owner"),
    leaseUntil: text("lease_until"),
    pendingResume: text("pending_resume").notNull().default("false"),
    lastResumeNonce: text("last_resume_nonce"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("goals_workspace_idx").on(table.workspaceSessionId, table.updatedAt),
    index("goals_status_idx").on(table.status, table.updatedAt),
  ],
);

export const goalCriteria = sqliteTable(
  "goal_criteria",
  {
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id").notNull(),
    description: text("description").notNull(),
    required: text("required").notNull().default("true"),
    status: text("status").notNull().default("pending"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    verificationSource: text("verification_source"),
    verificationTime: text("verification_time"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.goalId, table.criterionId] }),
    index("goal_criteria_status_idx").on(table.goalId, table.status),
  ],
);

export const goalConversationBindings = sqliteTable(
  "goal_conversation_bindings",
  {
    conversationScopeId: text("conversation_scope_id").primaryKey(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("goal_conversation_bindings_goal_idx").on(table.goalId, table.lastUsedAt),
  ],
);

export const goalEvents = sqliteTable(
  "goal_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    roundNumber: integer("round_number").notNull().default(0),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("goal_events_goal_idx").on(table.goalId, table.id),
  ],
);

export const goalBrowserBindings = sqliteTable(
  "goal_browser_bindings",
  {
    goalId: text("goal_id")
      .primaryKey()
      .references(() => goals.id, { onDelete: "cascade" }),
    adapter: text("adapter").notNull(),
    conversationUrl: text("conversation_url"),
    conversationKey: text("conversation_key"),
    rotationCount: integer("rotation_count").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    effort: text("effort"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    errorCode: text("error_code"),
    errorRetryable: text("error_retryable"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type WorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferSelect;
export type NewWorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferInsert;
export type WorkspaceTaskCheckpointRow = typeof workspaceTaskCheckpoints.$inferSelect;
export type NewWorkspaceTaskCheckpointRow = typeof workspaceTaskCheckpoints.$inferInsert;
export type GoalRow = typeof goals.$inferSelect;
export type NewGoalRow = typeof goals.$inferInsert;
export type GoalCriterionRow = typeof goalCriteria.$inferSelect;
export type NewGoalCriterionRow = typeof goalCriteria.$inferInsert;
export type GoalConversationBindingRow = typeof goalConversationBindings.$inferSelect;
export type GoalEventRow = typeof goalEvents.$inferSelect;
export type GoalBrowserBindingRow = typeof goalBrowserBindings.$inferSelect;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
