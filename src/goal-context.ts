import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { GoalEvent, PersistentGoal } from "./goal-store.js";

const GOAL_CONTEXT_DIR = "goal-context";
const GOAL_CONTEXT_PREFIX = "@context/";
const HYDRATE_MAX_CHARS = 12_000;
const MANIFEST_MAX_CHARS = 8_000;
const TOPIC_MAX_CHARS = 24_000;
const PROJECT_DOCS_MAX_CHARS = 24_000;
const HISTORY_MAX_EVENTS = 30;
const PROJECT_DOC_MAX_FILES = 160;
const PROJECT_DOC_MAX_DEPTH = 6;
const PROJECT_DOC_MAX_HEADINGS_PER_FILE = 80;
const PROJECT_DOC_SCAN_CHARS_PER_FILE = 1_000_000;
const PROJECT_DOC_CANDIDATE_CACHE_TTL_MS = 5_000;
const TRUNCATION_NOTICE = "\n\n[Derived recovery context truncated to its bounded context budget.]\n";

const CONTEXT_FILES = new Set([
  "hydrate.md",
  "manifest.md",
  "state.md",
  "decisions.md",
  "failures.md",
  "evidence.md",
  "history.md",
  "project-docs.md",
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

export interface GoalContextRefreshOptions {
  workspaceRoot?: string;
}

interface ProjectMarkdownHeading {
  line: number;
  level: number;
  text: string;
}

interface ProjectMarkdownDocument {
  path: string;
  bytes: number;
  modifiedAt: string;
  headings: ProjectMarkdownHeading[];
  partial: boolean;
  score: number;
}

interface ProjectMarkdownIndex {
  workspaceRoot: string;
  documents: ProjectMarkdownDocument[];
  discoveredFiles: number;
  indexedBytes: number;
  truncated: boolean;
}

interface ProjectMarkdownCache {
  candidates: Map<string, {
    expiresAt: number;
    paths: string[];
    truncated: boolean;
  }>;
  headings: Map<string, {
    bytes: number;
    modifiedMs: number;
    headings: ProjectMarkdownHeading[];
    partial: boolean;
  }>;
}

/**
 * Derived, bounded Markdown recovery cache for a durable Goal.
 *
 * This cache is deliberately not a source of truth. Goal state remains in SQLite and the
 * workspace Git/filesystem remains authoritative. The files only make compact recovery facts
 * addressable without replaying a Chat transcript.
 */
export class GoalContextStore {
  private readonly projectMarkdownCache: ProjectMarkdownCache = {
    candidates: new Map(),
    headings: new Map(),
  };

  constructor(private readonly stateDir: string) {}

  async refresh(
    goal: PersistentGoal,
    events: readonly GoalEvent[],
    options: GoalContextRefreshOptions = {},
  ): Promise<GoalContextSnapshot> {
    const sourceRevisionAt = latestSourceTimestamp(goal, events);
    const generatedAt = new Date().toISOString();
    const profile = chooseHydrationProfile(goal);
    const directory = goalContextDirectory(this.stateDir, goal.workspaceSessionId, goal.id);
    await mkdir(directory, { recursive: true });

    const refs = goalContextRefs(goal.id);
    const projectDocs = options.workspaceRoot
      ? await buildProjectMarkdownIndex(options.workspaceRoot, goal, this.projectMarkdownCache)
      : undefined;
    const documents = buildGoalContextDocuments(goal, events.slice(-HISTORY_MAX_EVENTS), {
      generatedAt: sourceRevisionAt,
      profile,
      refs,
      projectDocs,
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
  projectDocs: string;
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
    projectDocs: `${prefix}project-docs.md`,
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
    projectDocs?: ProjectMarkdownIndex;
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
  const projectDocs = renderProjectDocs(goal, input.generatedAt, input.projectDocs);
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
    "project-docs.md": bounded(projectDocs, PROJECT_DOCS_MAX_CHARS),
  };
}

function renderHydrate(
  goal: PersistentGoal,
  input: {
    generatedAt: string;
    profile: GoalHydrationProfile;
    refs: ReturnType<typeof goalContextRefs>;
    projectDocs?: ProjectMarkdownIndex;
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

  const projectLeads = input.projectDocs?.documents.slice(0, 6) ?? [];
  if (projectLeads.length > 0) {
    sections.push(
      "",
      "## Project Markdown leads",
      ...projectLeads.map((document) => projectLead(document)),
      `- Full bounded project Markdown index: ${input.refs.projectDocs}`,
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
    `- Project Markdown heading index: ${input.refs.projectDocs}`,
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
    projectDocs?: ProjectMarkdownIndex;
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
    `- ${input.refs.projectDocs} — workspace Markdown paths/headings only; source files remain authoritative`,
    "",
    "## Current focus",
    `- Objective: ${goal.objective}`,
    goal.currentStep ? `- Current step: ${goal.currentStep}` : undefined,
    goal.nextStep ? `- Next step: ${goal.nextStep}` : undefined,
  ]);
}

function renderProjectDocs(
  goal: PersistentGoal,
  generatedAt: string,
  index: ProjectMarkdownIndex | undefined,
): string {
  if (!index) {
    return lines([
      "# Project Markdown Index",
      authorityBanner(goal, generatedAt),
      "",
      "No workspace Markdown index was generated for this recovery refresh.",
    ]);
  }
  const output: Array<string | undefined> = [
    "# Project Markdown Index",
    authorityBanner(goal, generatedAt),
    "",
    "This file indexes source Markdown; it does not copy source bodies. Read the workspace source file for authoritative content.",
    `Indexed Markdown files: ${index.documents.length}/${index.discoveredFiles}${index.truncated ? " (bounded scan truncated)" : ""}`,
    `Indexed source bytes: ${index.indexedBytes}`,
    "",
  ];
  for (const document of index.documents) {
    output.push(
      `## ${document.path}`,
      `- bytes: ${document.bytes}`,
      `- modified: ${document.modifiedAt}`,
      `- relevance_score: ${document.score}`,
      document.partial ? `- heading_scan: first ${PROJECT_DOC_SCAN_CHARS_PER_FILE} characters only` : "- heading_scan: complete",
    );
    if (document.headings.length === 0) {
      output.push("- headings: none found in bounded scan", "");
      continue;
    }
    output.push("- headings:");
    for (const heading of document.headings) {
      output.push(`  - L${heading.line} ${"#".repeat(heading.level)} ${heading.text}`);
    }
    output.push("");
  }
  return lines(output);
}

function projectLead(document: ProjectMarkdownDocument): string {
  const heading = document.headings[0];
  return heading
    ? `- ${document.path} — L${heading.line} ${"#".repeat(heading.level)} ${heading.text}`
    : `- ${document.path} — no Markdown heading found in bounded scan`;
}

async function buildProjectMarkdownIndex(
  workspaceRoot: string,
  goal: PersistentGoal,
  cache: ProjectMarkdownCache,
): Promise<ProjectMarkdownIndex> {
  const root = resolve(workspaceRoot);
  const now = Date.now();
  const cachedCandidates = cache.candidates.get(root);
  let candidates: string[];
  let truncated: boolean;
  if (cachedCandidates && cachedCandidates.expiresAt > now) {
    candidates = cachedCandidates.paths;
    truncated = cachedCandidates.truncated;
  } else {
    candidates = [];
    truncated = false;
    await walkMarkdown(root, root, 0, candidates, () => { truncated = true; });
    cache.candidates.set(root, {
      expiresAt: now + PROJECT_DOC_CANDIDATE_CACHE_TTL_MS,
      paths: candidates,
      truncated,
    });
  }
  const terms = goalSearchTerms(goal);
  const documents: ProjectMarkdownDocument[] = [];
  let indexedBytes = 0;
  const activePaths = new Set(candidates);
  for (const absolutePath of candidates) {
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) continue;
      const path = normalizeRelativePath(relative(root, absolutePath));
      const cachedHeadingScan = cache.headings.get(absolutePath);
      const headingScan = cachedHeadingScan
        && cachedHeadingScan.bytes === info.size
        && cachedHeadingScan.modifiedMs === info.mtimeMs
        ? {
            headings: cachedHeadingScan.headings,
            partial: cachedHeadingScan.partial,
          }
        : await scanMarkdownHeadings(absolutePath);
      if (headingScan !== cachedHeadingScan) {
        cache.headings.set(absolutePath, {
          bytes: info.size,
          modifiedMs: info.mtimeMs,
          headings: headingScan.headings,
          partial: headingScan.partial,
        });
      }
      const score = scoreProjectDocument(path, headingScan.headings, terms);
      documents.push({
        path,
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        headings: headingScan.headings,
        partial: headingScan.partial,
        score,
      });
      indexedBytes += info.size;
    } catch {
      // Derived project-document indexing is best effort. Source reads remain authoritative.
    }
  }
  for (const cachedPath of cache.headings.keys()) {
    if (cachedPath.startsWith(`${root}\\`) || cachedPath.startsWith(`${root}/`)) {
      if (!activePaths.has(cachedPath)) cache.headings.delete(cachedPath);
    }
  }
  documents.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    workspaceRoot: root,
    documents,
    discoveredFiles: candidates.length,
    indexedBytes,
    truncated,
  };
}

async function walkMarkdown(
  root: string,
  directory: string,
  depth: number,
  output: string[],
  onTruncated: () => void,
): Promise<void> {
  if (depth > PROJECT_DOC_MAX_DEPTH || output.length >= PROJECT_DOC_MAX_FILES) {
    onTruncated();
    return;
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (output.length >= PROJECT_DOC_MAX_FILES) {
      onTruncated();
      return;
    }
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredProjectDocDirectory(entry.name)) continue;
      await walkMarkdown(root, absolute, depth + 1, output, onTruncated);
      continue;
    }
    if (!entry.isFile() || !/\.md(?:own)?$/i.test(entry.name)) continue;
    output.push(absolute);
  }
}

async function scanMarkdownHeadings(path: string): Promise<{
  headings: ProjectMarkdownHeading[];
  partial: boolean;
}> {
  const headings: ProjectMarkdownHeading[] = [];
  let consumedChars = 0;
  let lineNumber = 0;
  let partial = false;
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      lineNumber += 1;
      consumedChars += line.length + 1;
      if (consumedChars > PROJECT_DOC_SCAN_CHARS_PER_FILE) {
        partial = true;
        break;
      }
      if (headings.length >= PROJECT_DOC_MAX_HEADINGS_PER_FILE) {
        partial = true;
        break;
      }
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      headings.push({
        line: lineNumber,
        level: match[1]!.length,
        text: match[2]!.slice(0, 240),
      });
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return { headings, partial };
}

function ignoredProjectDocDirectory(name: string): boolean {
  return new Set([
    ".git",
    ".devpilot-runtime",
    ".devpilot-config",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    "vendor",
  ]).has(name.toLowerCase());
}

function goalSearchTerms(goal: PersistentGoal): string[] {
  const source = [
    goal.objective,
    goal.summary,
    goal.currentStep,
    goal.nextStep,
    goal.resumeCapsule.currentState,
    goal.resumeCapsule.currentProblem,
    ...(goal.resumeCapsule.nextActions ?? []),
    ...(goal.resumeCapsule.decisions ?? []),
  ].filter((value): value is string => Boolean(value)).join(" ").toLowerCase();
  const terms = new Set<string>();
  for (const match of source.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu)) {
    const token = match[0];
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length >= 2) terms.add(token.slice(0, 24));
      for (let index = 0; index + 1 < token.length && terms.size < 48; index += 1) {
        terms.add(token.slice(index, index + 2));
      }
    } else if (token.length >= 3) {
      terms.add(token.slice(0, 48));
    }
    if (terms.size >= 48) break;
  }
  return [...terms];
}

function scoreProjectDocument(
  path: string,
  headings: readonly ProjectMarkdownHeading[],
  terms: readonly string[],
): number {
  const normalizedPath = path.toLowerCase();
  const headingText = headings.map((heading) => heading.text.toLowerCase()).join(" ");
  let score = 0;
  for (const term of terms) {
    if (normalizedPath.includes(term)) score += 12;
    if (headingText.includes(term)) score += 5;
  }
  const file = basename(path).toLowerCase();
  if (file === "readme.md") score += 3;
  if (file === "changelog.md") score += 2;
  return score;
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
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
    `> Goal: \`${goal.id}\` · Workspace: \`${goal.workspaceSessionId}\` · Goal updated: ${goal.updatedAt} · Source revision: ${generatedAt}`,
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
