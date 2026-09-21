import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GoalEvent, PersistentGoal } from "./goal-store.js";

const GOAL_CONTEXT_DIR = "goal-context";
const GOAL_CONTEXT_PREFIX = "@context/";
const HYDRATE_MAX_CHARS = 12_000;
const MANIFEST_MAX_CHARS = 8_000;
const TOPIC_MAX_CHARS = 24_000;
const HISTORY_MAX_EVENTS = 30;
const TRUNCATION_NOTICE = "\n\n[Derived recovery context truncated to its bounded context budget.]\n";

const CONTEXT_FILES = new Set([
  "hydrate.md",
  "manifest.md",
  "state.md",
  "decisions.md",
  "failures.md",
  "evidence.md",
  "history.md",
]);

export type GoalHydrationProfile = "minimal" | "normal" | "debug" | "verification";

export interface GoalContextSnapshot {
  goalId: string;
  workspaceId: string;
  generatedAt: string;
  goalUpdatedAt: string;
  profile: GoalHydrationProfile;
  hydrateRef: string;
  manifestRef: string;
}

export interface GoalContextReadPath {
  absolutePath: string;
  root: string;
}

/**
 * Derived, bounded Markdown recovery cache for a durable Goal.
 *
 * This cache is deliberately not a source of truth. Goal state remains in SQLite and the
 * workspace Git/filesystem remains authoritative. The files only make compact recovery facts
 * addressable without replaying a Chat transcript.
 */
export class GoalContextStore {
  constructor(private readonly stateDir: string) {}

  async refresh(goal: PersistentGoal, events: readonly GoalEvent[]): Promise<GoalContextSnapshot> {
    const generatedAt = latestSourceTimestamp(goal, events);
    const profile = chooseHydrationProfile(goal);
    const directory = goalContextDirectory(this.stateDir, goal.workspaceSessionId, goal.id);
    await mkdir(directory, { recursive: true });

    const refs = goalContextRefs(goal.id);
    const documents = buildGoalContextDocuments(goal, events.slice(-HISTORY_MAX_EVENTS), {
      generatedAt,
      profile,
      refs,
    });
    await Promise.all(
      Object.entries(documents).map(([name, content]) => writeIfChanged(join(directory, name), content)),
    );

    return {
      goalId: goal.id,
      workspaceId: goal.workspaceSessionId,
      generatedAt,
      goalUpdatedAt: goal.updatedAt,
      profile,
      hydrateRef: refs.hydrate,
      manifestRef: refs.manifest,
    };
  }
}

function latestSourceTimestamp(goal: PersistentGoal, events: readonly GoalEvent[]): string {
  let latest = goal.updatedAt;
  for (const event of events) {
    if (event.createdAt > latest) latest = event.createdAt;
  }
  return latest;
}

export function resolveGoalContextReadPath(
  stateDir: string,
  workspaceId: string,
  inputPath: string,
): GoalContextReadPath | undefined {
  const normalized = inputPath.replaceAll("\\", "/");
  if (!normalized.startsWith(GOAL_CONTEXT_PREFIX)) return undefined;

  const parts = normalized.split("/");
  if (parts.length !== 3 || parts[0] !== "@context") {
    throw new Error("Goal recovery context paths must use @context/<goal_id>/<file>.md.");
  }
  const [, goalId, fileName] = parts;
  if (!safeContextSegment(workspaceId) || !goalId || !safeContextSegment(goalId)) {
    throw new Error("Goal recovery context path contains an invalid identifier.");
  }
  if (!fileName || !CONTEXT_FILES.has(fileName)) {
    throw new Error(`Unsupported Goal recovery context file: ${fileName ?? ""}`);
  }

  const root = goalContextDirectory(stateDir, workspaceId, goalId);
  return {
    root,
    absolutePath: join(root, fileName),
  };
}

export function goalContextRefs(goalId: string): {
  hydrate: string;
  manifest: string;
  state: string;
  decisions: string;
  failures: string;
  evidence: string;
  history: string;
} {
  if (!safeContextSegment(goalId)) throw new Error(`Invalid Goal id for recovery context: ${goalId}`);
  const prefix = `${GOAL_CONTEXT_PREFIX}${goalId}/`;
  return {
    hydrate: `${prefix}hydrate.md`,
    manifest: `${prefix}manifest.md`,
    state: `${prefix}state.md`,
    decisions: `${prefix}decisions.md`,
    failures: `${prefix}failures.md`,
    evidence: `${prefix}evidence.md`,
    history: `${prefix}history.md`,
  };
}

export function chooseHydrationProfile(goal: PersistentGoal): GoalHydrationProfile {
  const capsule = goal.resumeCapsule;
  const searchable = [
    goal.summary,
    goal.currentStep,
    goal.nextStep,
    capsule.currentState,
    capsule.currentProblem,
    ...(capsule.nextActions ?? []),
  ].filter(Boolean).join(" ").toLowerCase();

  if (
    goal.status === "verifying"
    || /\b(verify|verification|test|e2e|benchmark|release|audit|typecheck|build|pass|fail)\b/.test(searchable)
  ) {
    return "verification";
  }
  if (
    (capsule.failures?.length ?? 0) > 0
    || /\b(debug|bug|error|failure|crash|regression|broken|timeout|duplicate)\b/.test(searchable)
  ) {
    return "debug";
  }
  if (
    (capsule.decisions?.length ?? 0) > 0
    || (capsule.evidence?.length ?? 0) > 0
    || Boolean(capsule.currentState || capsule.currentProblem)
  ) {
    return "normal";
  }
  return "minimal";
}

function buildGoalContextDocuments(
  goal: PersistentGoal,
  events: readonly GoalEvent[],
  input: {
    generatedAt: string;
    profile: GoalHydrationProfile;
    refs: ReturnType<typeof goalContextRefs>;
  },
): Record<string, string> {
  const state = renderState(goal, input.generatedAt);
  const decisions = renderListTopic(
    "Decisions",
    goal,
    input.generatedAt,
    goal.resumeCapsule.decisions ?? [],
    "No durable decisions are currently recorded in the Resume Capsule.",
  );
  const failures = renderListTopic(
    "Failures / Avoid Repeating",
    goal,
    input.generatedAt,
    goal.resumeCapsule.failures ?? [],
    "No durable failed strategies are currently recorded in the Resume Capsule.",
  );
  const evidence = renderEvidence(goal, input.generatedAt);
  const history = renderHistory(goal, events, input.generatedAt);
  const manifest = renderManifest(goal, input);
  const hydrate = renderHydrate(goal, input);

  return {
    "hydrate.md": bounded(hydrate, HYDRATE_MAX_CHARS),
    "manifest.md": bounded(manifest, MANIFEST_MAX_CHARS),
    "state.md": bounded(state, TOPIC_MAX_CHARS),
    "decisions.md": bounded(decisions, TOPIC_MAX_CHARS),
    "failures.md": bounded(failures, TOPIC_MAX_CHARS),
    "evidence.md": bounded(evidence, TOPIC_MAX_CHARS),
    "history.md": bounded(history, TOPIC_MAX_CHARS),
  };
}

function renderHydrate(
  goal: PersistentGoal,
  input: {
    generatedAt: string;
    profile: GoalHydrationProfile;
    refs: ReturnType<typeof goalContextRefs>;
  },
): string {
  const capsule = goal.resumeCapsule;
  const remainingCriteria = goal.criteria.filter((criterion) => criterion.required && criterion.status !== "passed");
  const sections = [
    "# Goal Recovery Hydration",
    authorityBanner(goal, input.generatedAt),
    `Hydration profile: **${input.profile}**`,
    "",
    "## Current focus",
    `- Objective: ${goal.objective}`,
    `- Status: ${goal.status}; round ${goal.roundNumber}`,
    goal.summary ? `- Summary: ${goal.summary}` : undefined,
    goal.currentStep ? `- Current step: ${goal.currentStep}` : undefined,
    goal.nextStep ? `- Next step: ${goal.nextStep}` : undefined,
    capsule.currentState ? `- Current state: ${capsule.currentState}` : undefined,
    capsule.currentProblem ? `- Current problem: ${capsule.currentProblem}` : undefined,
    "",
    "## Hard constraints",
    ...bullets(uniqueStrings([...(goal.constraints ?? []), ...(capsule.hardConstraints ?? [])]), "No additional hard constraints recorded."),
    "",
    "## Remaining required criteria",
    ...bullets(
      remainingCriteria.map((criterion) => `${criterion.id}: ${criterion.description} [${criterion.status}]`),
      "All required criteria are currently passed.",
    ),
    "",
    "## Next actions",
    ...bullets(capsule.nextActions ?? [], goal.nextStep ?? "No next actions recorded."),
  ];

  if (input.profile !== "minimal") {
    sections.push(
      "",
      "## Decisions worth carrying forward",
      ...bullets(capsule.decisions ?? [], `Read ${input.refs.decisions} if decision history is needed.`),
    );
  }
  if (input.profile === "debug" || input.profile === "verification") {
    sections.push(
      "",
      "## Known failures / traps",
      ...bullets(capsule.failures ?? [], `Read ${input.refs.failures} if failure history is needed.`),
    );
  }
  if (input.profile === "verification") {
    sections.push(
      "",
      "## Verification evidence",
      ...bullets(compactEvidence(goal), `Read ${input.refs.evidence} for detailed bounded evidence.`),
    );
  }

  sections.push(
    "",
    "## Expand only if needed",
    `- Full context index: ${input.refs.manifest}`,
    `- Durable state: ${input.refs.state}`,
    `- Decisions: ${input.refs.decisions}`,
    `- Failures: ${input.refs.failures}`,
    `- Evidence: ${input.refs.evidence}`,
    `- Bounded Goal event history: ${input.refs.history}`,
    "",
    "Do not reconstruct the task from an old Chat transcript. Read only the additional topic files required by the current step, then inspect authoritative source/Git/Goal state when correctness depends on it.",
  );
  return lines(sections);
}

function renderManifest(
  goal: PersistentGoal,
  input: {
    generatedAt: string;
    profile: GoalHydrationProfile;
    refs: ReturnType<typeof goalContextRefs>;
  },
): string {
  return lines([
    "# Persistent Goal Context Manifest",
    authorityBanner(goal, input.generatedAt),
    `Hydration profile: **${input.profile}**`,
    "",
    "## Recommended recovery order",
    `1. Read ${input.refs.hydrate}.`,
    "2. Read only topic files relevant to the current step.",
    "3. Use workspace delta / source reads for authoritative current state.",
    "",
    "## Topic index",
    `- ${input.refs.state} — objective, status, constraints, actions, criteria`,
    `- ${input.refs.decisions} — bounded durable decisions`,
    `- ${input.refs.failures} — bounded failed strategies and traps`,
    `- ${input.refs.evidence} — criterion and Resume Capsule evidence`,
    `- ${input.refs.history} — recent durable Goal events, not transcript`,
    "",
    "## Current focus",
    `- Objective: ${goal.objective}`,
    goal.currentStep ? `- Current step: ${goal.currentStep}` : undefined,
    goal.nextStep ? `- Next step: ${goal.nextStep}` : undefined,
  ]);
}

function renderState(goal: PersistentGoal, generatedAt: string): string {
  const capsule = goal.resumeCapsule;
  return lines([
    "# Goal State",
    authorityBanner(goal, generatedAt),
    "",
    "## Current",
    `- Objective: ${goal.objective}`,
    `- Status: ${goal.status}`,
    `- Round: ${goal.roundNumber}`,
    goal.summary ? `- Summary: ${goal.summary}` : undefined,
    goal.currentStep ? `- Current step: ${goal.currentStep}` : undefined,
    goal.nextStep ? `- Next step: ${goal.nextStep}` : undefined,
    capsule.currentState ? `- Current state: ${capsule.currentState}` : undefined,
    capsule.currentProblem ? `- Current problem: ${capsule.currentProblem}` : undefined,
    "",
    "## Constraints",
    ...bullets(uniqueStrings([...(goal.constraints ?? []), ...(capsule.hardConstraints ?? [])]), "None recorded."),
    "",
    "## Completed",
    ...bullets(uniqueStrings([...(capsule.completed ?? []), ...(capsule.workCompleted ?? [])]), "None recorded."),
    "",
    "## Remaining",
    ...bullets(capsule.remaining ?? [], "None recorded."),
    "",
    "## Next actions",
    ...bullets(capsule.nextActions ?? [], goal.nextStep ?? "None recorded."),
    "",
    "## Acceptance criteria",
    ...goal.criteria.map((criterion) => (
      `- [${criterion.status === "passed" ? "x" : " "}] ${criterion.id} (${criterion.required ? "required" : "optional"}): ${criterion.description} — ${criterion.status}`
    )),
  ]);
}

function renderListTopic(
  title: string,
  goal: PersistentGoal,
  generatedAt: string,
  values: readonly string[],
  empty: string,
): string {
  return lines([
    `# ${title}`,
    authorityBanner(goal, generatedAt),
    "",
    ...bullets(values, empty),
  ]);
}

function renderEvidence(goal: PersistentGoal, generatedAt: string): string {
  const sections: Array<string | undefined> = [
    "# Goal Evidence",
    authorityBanner(goal, generatedAt),
    "",
    "## Resume Capsule evidence",
    ...bullets(goal.resumeCapsule.evidence ?? [], "No Resume Capsule evidence recorded."),
    "",
    "## Criterion evidence",
  ];
  for (const criterion of goal.criteria) {
    sections.push(`### ${criterion.id} — ${criterion.status}`);
    sections.push(`Required: ${criterion.required ? "yes" : "no"}`);
    if (criterion.verificationSource) sections.push(`Verification source: ${criterion.verificationSource}`);
    if (criterion.verificationTime) sections.push(`Verification time: ${criterion.verificationTime}`);
    sections.push(...bullets(
      criterion.evidence.map((evidence) => (
        `${evidence.kind}: ${evidence.summary}${evidence.ref ? ` (ref: ${evidence.ref})` : ""}`
      )),
      "No evidence recorded.",
    ));
    sections.push("");
  }
  return lines(sections);
}

function renderHistory(goal: PersistentGoal, events: readonly GoalEvent[], generatedAt: string): string {
  return lines([
    "# Recent Goal Journal",
    authorityBanner(goal, generatedAt),
    "",
    "This is bounded durable event metadata, not a Chat transcript and not hidden reasoning.",
    "",
    ...bullets(events.map((event) => {
      const payload = Object.keys(event.payload).length > 0 ? ` ${JSON.stringify(event.payload)}` : "";
      return `${event.createdAt} · round ${event.roundNumber} · ${event.kind}${payload}`;
    }), "No durable Goal events recorded."),
  ]);
}

function authorityBanner(goal: PersistentGoal, generatedAt: string): string {
  return [
    "> **Derived recovery cache — not authoritative.** Goal DB is Goal truth; Git/filesystem is workspace truth.",
    `> Goal: \`${goal.id}\` · Workspace: \`${goal.workspaceSessionId}\` · Goal updated: ${goal.updatedAt} · Cache generated: ${generatedAt}`,
  ].join("\n");
}

function compactEvidence(goal: PersistentGoal): string[] {
  return uniqueStrings([
    ...(goal.resumeCapsule.evidence ?? []),
    ...goal.criteria.flatMap((criterion) => criterion.evidence.map((evidence) => (
      `${criterion.id}: ${evidence.summary}${evidence.ref ? ` (${evidence.ref})` : ""}`
    ))),
  ]).slice(0, 20);
}

function bullets(values: readonly string[], empty: string): string[] {
  const compact = uniqueStrings(values);
  return compact.length > 0 ? compact.map((value) => `- ${value}`) : [`- ${empty}`];
}

function uniqueStrings(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function lines(values: Array<string | undefined>): string {
  return `${values.filter((value): value is string => value !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function bounded(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keep = Math.max(0, maxChars - TRUNCATION_NOTICE.length);
  return `${value.slice(0, keep).trimEnd()}${TRUNCATION_NOTICE}`;
}

function safeContextSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function goalContextDirectory(stateDir: string, workspaceId: string, goalId: string): string {
  if (!safeContextSegment(workspaceId) || !safeContextSegment(goalId)) {
    throw new Error("Goal recovery context identifiers contain unsupported characters.");
  }
  return resolve(stateDir, GOAL_CONTEXT_DIR, workspaceId, goalId);
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if (await readFile(path, "utf8") === content) return;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  await writeFile(path, content, "utf8");
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
