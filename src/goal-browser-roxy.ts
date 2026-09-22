import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, dirname, join, resolve, sep } from "node:path";
import type {
  GoalBrowserBinding,
  PersistentGoal,
} from "./goal-store.js";
import type {
  GoalBrowserAdapter,
  GoalBrowserSendResult,
  GoalBrowserSnapshot,
} from "./goal-watchdog.js";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_NEW_CHAT_URL = `${CHATGPT_ORIGIN}/`;
const DEFAULT_ROXY_API_HOST = "http://127.0.0.1:50000";
const CDP_TIMEOUT_MS = 10_000;
const CHATGPT_READY_TIMEOUT_MS = 30_000;
const SEND_READY_TIMEOUT_MS = 3_000;
const SUBMISSION_TIMEOUT_MS = 12_000;

const COMPOSER_SELECTORS = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][role="textbox"]',
  "textarea",
];

const STOP_SELECTOR = '[data-testid="stop-button"]';
const ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
].join(", ");
const USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
].join(", ");

export interface AsterBridgeRoxySettings {
  sourcePath: string;
  userDataDir: string;
  profileId: string;
  dataDir: string;
  autoOpen: boolean;
  apiHost: string;
  apiKeyFile?: string;
}

interface DevToolsActivePort {
  port: number;
  path: string;
}

interface CdpTargetInfo {
  targetId: string;
  type: string;
  url: string;
  title?: string;
}

interface AttachedPage {
  cdp: CdpClient;
  targetId: string;
  sessionId: string;
}

interface DomState {
  url: string;
  composerVisible: boolean;
  generating: boolean;
  loginRequired: boolean;
  offline: boolean;
  conversationLimit: boolean;
  rateLimited: boolean;
  terminalError: boolean;
  draftNonEmpty: boolean;
  alertText: string;
  userTurns: number;
  assistantTurns: number;
  visibleConversationChars: number;
}

export class AsterBridgeRoxyGoalBrowserAdapter implements GoalBrowserAdapter {
  readonly id = "asterbridge-roxy-cdp";

  constructor(
    private readonly settings = discoverAsterBridgeRoxySettings(),
  ) {}

  async inspect(input: {
    goal: PersistentGoal;
    binding?: GoalBrowserBinding;
  }): Promise<GoalBrowserSnapshot> {
    const page = await this.openGoalPage(input.binding);
    try {
      const state = await waitForDomState(page, CHATGPT_READY_TIMEOUT_MS, false);
      return snapshotFromDomState(state, page.targetId);
    } finally {
      page.cdp.close();
    }
  }

  async sendContinuation(input: {
    goal: PersistentGoal;
    binding?: GoalBrowserBinding;
    prompt: string;
    roundNumber: number;
    resumeNonce: string;
  }): Promise<GoalBrowserSendResult> {
    const page = await this.openGoalPage(input.binding);
    try {
      return await sendPrompt(page, input.prompt);
    } finally {
      page.cdp.close();
    }
  }

  async rotateConversation(input: {
    goal: PersistentGoal;
    binding?: GoalBrowserBinding;
    prompt: string;
    roundNumber: number;
    resumeNonce: string;
  }): Promise<GoalBrowserSendResult> {
    const cdp = await this.connect();
    try {
      const created = await cdp.send<{ targetId: string }>("Target.createTarget", {
        url: CHATGPT_NEW_CHAT_URL,
        newWindow: false,
      });
      const attached = await attachPage(cdp, created.targetId);
      return await sendPrompt(attached, input.prompt);
    } finally {
      cdp.close();
    }
  }

  private async connect(): Promise<CdpClient> {
    const endpoint = await ensureRoxyCdpEndpoint(this.settings);
    return await CdpClient.connect(endpoint);
  }

  private async openGoalPage(binding?: GoalBrowserBinding): Promise<AttachedPage> {
    const cdp = await this.connect();
    try {
      const targets = await listPageTargets(cdp);
      let target = binding?.conversationKey
        ? targets.find((candidate) => candidate.targetId === binding.conversationKey)
        : undefined;
      const conversationUrl = binding?.conversationUrl;
      if (!target && conversationUrl) {
        target = targets.find((candidate) => sameConversationUrl(candidate.url, conversationUrl));
      }
      if (!target && conversationUrl) {
        const created = await cdp.send<{ targetId: string }>("Target.createTarget", {
          url: conversationUrl,
          newWindow: false,
        });
        target = { targetId: created.targetId, type: "page", url: conversationUrl };
      }
      if (!target) {
        target = await findUniqueGeneratingChatGptTarget(cdp, targets);
        if (!target) {
          throw new Error(
            "Goal has no browser binding and RoxyBrowser has no unique generating ChatGPT page to adopt. "
            + "Start the Goal from the configured RoxyBrowser ChatGPT page or bind it explicitly before automatic continuation.",
          );
        }
      }
      return await attachPage(cdp, target.targetId);
    } catch (error) {
      cdp.close();
      throw error;
    }
  }
}

async function findUniqueGeneratingChatGptTarget(
  cdp: CdpClient,
  targets: CdpTargetInfo[],
): Promise<CdpTargetInfo | undefined> {
  const candidates = targets.filter((target) => isChatGptUrl(target.url));
  const generating: CdpTargetInfo[] = [];
  for (const candidate of candidates) {
    const page = await attachPage(cdp, candidate.targetId);
    try {
      const state = await readDomState(page);
      if (state.generating && !state.loginRequired && !state.terminalError) generating.push(candidate);
    } catch {
      // A stale or mid-navigation target is not safe to adopt. Continue looking rather than
      // guessing which ChatGPT tab owns the Goal turn.
    }
  }
  return generating.length === 1 ? generating[0] : undefined;
}

export function discoverAsterBridgeRoxySettings(
  env: NodeJS.ProcessEnv = process.env,
): AsterBridgeRoxySettings {
  const explicitLauncherState = env.ASTERBRIDGE_LAUNCHER_STATE?.trim();
  const explicitCoreConfig = env.ASTERBRIDGE_CORE_CONFIG?.trim();
  const appData = env.APPDATA?.trim();
  const coreHome = env.CODEX_CHATGPT_WEB_HOME?.trim();
  const coreConfigCandidates = [
    ...(explicitCoreConfig ? [resolve(explicitCoreConfig)] : []),
    ...(coreHome ? [join(resolve(coreHome), "config.json")] : []),
    join(homedir(), ".codex-chatgpt-web", "config.json"),
  ];
  const coreConfigs = coreConfigCandidates
    .map((configPath) => ({ configPath, config: readJsonRecord(configPath) }))
    .filter((entry): entry is { configPath: string; config: Record<string, unknown> } => Boolean(entry.config));
  const launcherCandidates = [
    ...(explicitLauncherState ? [resolve(explicitLauncherState)] : []),
    ...(appData ? [
      join(appData, "AsterBridge", "launcher-state.json"),
      join(appData, "Codex Web GPT", "launcher-state.json"),
    ] : []),
  ];
  for (const launcherStatePath of launcherCandidates) {
    const state = readJsonRecord(launcherStatePath);
    if (!state) continue;
    if (state.useRoxyBrowser !== true) continue;
    const profileId = validateProfileId(state.roxyBrowserProfileId);
    const dataDir = typeof state.roxyBrowserDataDir === "string" && isAbsolute(state.roxyBrowserDataDir)
      ? resolve(state.roxyBrowserDataDir)
      : undefined;
    if (!profileId || !dataDir) continue;
    const matchingCoreConfig = coreConfigs.find(({ config }) => {
      const configuredProfileId = validateProfileId(config.roxyBrowserProfileId);
      const configuredDataDir = typeof config.roxyBrowserDataDir === "string" && isAbsolute(config.roxyBrowserDataDir)
        ? resolve(config.roxyBrowserDataDir)
        : undefined;
      return configuredProfileId === profileId && configuredDataDir === dataDir;
    })?.config;
    const apiKeyFile = typeof matchingCoreConfig?.roxyBrowserApiKeyFile === "string"
      && isAbsolute(matchingCoreConfig.roxyBrowserApiKeyFile)
      ? resolve(matchingCoreConfig.roxyBrowserApiKeyFile)
      : undefined;
    return {
      sourcePath: launcherStatePath,
      userDataDir: dirname(launcherStatePath),
      profileId,
      dataDir,
      autoOpen: state.roxyBrowserAutoOpen === true || matchingCoreConfig?.roxyBrowserAutoOpen === true,
      apiHost: validateApiHost(
        typeof state.roxyBrowserApiHost === "string" && state.roxyBrowserApiHost.trim()
          ? state.roxyBrowserApiHost
          : typeof matchingCoreConfig?.roxyBrowserApiHost === "string" && matchingCoreConfig.roxyBrowserApiHost.trim()
            ? matchingCoreConfig.roxyBrowserApiHost
          : DEFAULT_ROXY_API_HOST,
      ),
      apiKeyFile,
    };
  }
  for (const { configPath, config } of coreConfigs) {
    if (config.turnBrowserHost !== "roxybrowser") continue;
    const profileId = validateProfileId(config.roxyBrowserProfileId);
    const dataDir = typeof config.roxyBrowserDataDir === "string" && isAbsolute(config.roxyBrowserDataDir)
      ? resolve(config.roxyBrowserDataDir)
      : undefined;
    if (!profileId || !dataDir) continue;
    const apiKeyFile = typeof config.roxyBrowserApiKeyFile === "string"
      && isAbsolute(config.roxyBrowserApiKeyFile)
      ? resolve(config.roxyBrowserApiKeyFile)
      : undefined;
    return {
      sourcePath: configPath,
      userDataDir: dirname(configPath),
      profileId,
      dataDir,
      autoOpen: config.roxyBrowserAutoOpen === true,
      apiHost: validateApiHost(
        typeof config.roxyBrowserApiHost === "string" && config.roxyBrowserApiHost.trim()
          ? config.roxyBrowserApiHost
          : DEFAULT_ROXY_API_HOST,
      ),
      apiKeyFile,
    };
  }
  throw new Error("AsterBridge does not have an enabled RoxyBrowser profile configuration.");
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

export function parseDevToolsActivePort(contents: string): DevToolsActivePort | undefined {
  const lines = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return undefined;
  const port = Number.parseInt(lines[0] ?? "", 10);
  const path = lines[1] ?? "";
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !path.startsWith("/devtools/browser/")) {
    return undefined;
  }
  return { port, path };
}

async function ensureRoxyCdpEndpoint(settings: AsterBridgeRoxySettings): Promise<string> {
  try {
    return await discoverRoxyCdpEndpoint(settings);
  } catch (error) {
    if (!settings.autoOpen) throw error;
  }

  const apiKeyPath = settings.apiKeyFile ?? join(settings.userDataDir, "secrets", "roxy-browser-api.key");
  if (!existsSync(apiKeyPath)) {
    throw new Error("RoxyBrowser profile is closed and AsterBridge has no stored Local API key for automatic startup.");
  }
  const apiKey = readFileSync(apiKeyPath, "utf8").trim();
  if (apiKey.length < 8 || apiKey.length > 4096) throw new Error("AsterBridge RoxyBrowser Local API key is invalid.");
  await roxyApiRequest(settings.apiHost, apiKey, "/health");
  await roxyApiRequest(settings.apiHost, apiKey, "/browser/open", {
    method: "POST",
    body: JSON.stringify({ dirId: settings.profileId, args: [] }),
  });
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await discoverRoxyCdpEndpoint(settings);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error("RoxyBrowser opened but did not expose a reachable CDP endpoint within 20 seconds.", {
    cause: lastError,
  });
}

async function discoverRoxyCdpEndpoint(settings: AsterBridgeRoxySettings): Promise<string> {
  const profileRoot = resolve(settings.dataDir);
  const profileDir = resolve(profileRoot, settings.profileId);
  const normalizedRoot = process.platform === "win32" ? profileRoot.toLowerCase() : profileRoot;
  const normalizedProfile = process.platform === "win32" ? profileDir.toLowerCase() : profileDir;
  if (!normalizedProfile.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("RoxyBrowser profile path escapes its configured data directory.");
  }
  const activePort = parseDevToolsActivePort(readFileSync(join(profileDir, "DevToolsActivePort"), "utf8"));
  if (!activePort) throw new Error("RoxyBrowser DevToolsActivePort is invalid or missing.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(`http://127.0.0.1:${activePort.port}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RoxyBrowser CDP probe returned HTTP ${response.status}.`);
    const body = await response.json() as Record<string, unknown>;
    const debuggerUrl = typeof body.webSocketDebuggerUrl === "string"
      ? body.webSocketDebuggerUrl
      : `ws://127.0.0.1:${activePort.port}${activePort.path}`;
    const parsed = new URL(debuggerUrl);
    if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1") {
      throw new Error("RoxyBrowser exposed a non-loopback CDP WebSocket URL.");
    }
    return debuggerUrl;
  } catch (error) {
    throw new Error("RoxyBrowser DevToolsActivePort is stale or its CDP endpoint is unreachable.", {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function roxyApiRequest(
  apiHost: string,
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${apiHost}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        token: apiKey,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`RoxyBrowser Local API returned HTTP ${response.status}.`);
    if (bodyText.trim()) {
      const body = JSON.parse(bodyText) as unknown;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        if (typeof record.code === "number" && record.code !== 0 && record.code !== 200) {
          throw new Error("RoxyBrowser Local API rejected the request.");
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("close", () => this.rejectAll(new Error("Chromium CDP connection closed.")));
    socket.addEventListener("error", () => this.rejectAll(new Error("Chromium CDP connection failed.")));
  }

  static async connect(endpoint: string): Promise<CdpClient> {
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("Timed out connecting to Chromium CDP.")), CDP_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error("Could not connect to Chromium CDP."));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`Chromium CDP command timed out: ${method}`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolveSend(value as T),
        reject: rejectSend,
        timer,
      });
    });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return await promise;
  }

  close(): void {
    try { this.socket.close(); } catch { /* ignore close races */ }
    this.rejectAll(new Error("Chromium CDP connection closed."));
  }

  private onMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let message: unknown;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    if (!Number.isInteger(record.id)) return;
    const id = record.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (record.error && typeof record.error === "object") {
      const error = record.error as Record<string, unknown>;
      pending.reject(new Error(typeof error.message === "string" ? error.message : "Chromium CDP command failed."));
      return;
    }
    pending.resolve(record.result ?? {});
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function listPageTargets(cdp: CdpClient): Promise<CdpTargetInfo[]> {
  const result = await cdp.send<{ targetInfos: CdpTargetInfo[] }>("Target.getTargets");
  return result.targetInfos.filter((target) => target.type === "page");
}

async function attachPage(cdp: CdpClient, targetId: string): Promise<AttachedPage> {
  const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp.send("Runtime.enable", {}, attached.sessionId);
  await cdp.send("Page.enable", {}, attached.sessionId);
  return { cdp, targetId, sessionId: attached.sessionId };
}

async function evaluate<T>(page: AttachedPage, expression: string): Promise<T> {
  const result = await page.cdp.send<{
    result?: { value?: T };
    exceptionDetails?: {
      text?: string;
      lineNumber?: number;
      columnNumber?: number;
      exception?: { description?: string; value?: unknown };
    };
  }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, page.sessionId);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description
      ?? (result.exceptionDetails.exception?.value !== undefined
        ? String(result.exceptionDetails.exception.value)
        : undefined)
      ?? result.exceptionDetails.text
      ?? "ChatGPT page evaluation failed.";
    const location = result.exceptionDetails.lineNumber !== undefined
      ? ` at ${result.exceptionDetails.lineNumber}:${result.exceptionDetails.columnNumber ?? 0}`
      : "";
    throw new Error(`${detail}${location}`);
  }
  return result.result?.value as T;
}

async function readDomState(page: AttachedPage): Promise<DomState> {
  return await evaluate<DomState>(page, domStateExpression());
}

async function waitForDomState(
  page: AttachedPage,
  timeoutMs: number,
  requireIdleComposer: boolean,
): Promise<DomState> {
  const deadline = Date.now() + timeoutMs;
  let latest: DomState | undefined;
  while (Date.now() < deadline) {
    latest = await readDomState(page);
    if (latest.loginRequired || latest.offline || latest.conversationLimit || latest.rateLimited || latest.terminalError) {
      return latest;
    }
    if (latest.composerVisible && (!requireIdleComposer || !latest.generating)) return latest;
    await sleep(100);
  }
  if (latest) return latest;
  throw new Error("ChatGPT page did not expose a readable DOM state.");
}

function snapshotFromDomState(state: DomState, targetId: string): GoalBrowserSnapshot {
  const common = {
    conversationUrl: state.url,
    conversationKey: targetId,
    userTurns: state.userTurns,
    assistantTurns: state.assistantTurns,
    visibleConversationChars: state.visibleConversationChars,
  };
  if (state.loginRequired) return { state: "login_required", ...common, detail: state.alertText || undefined };
  if (state.offline) return { state: "disconnected", ...common };
  if (state.conversationLimit) return { state: "conversation_limit", ...common, detail: state.alertText || undefined };
  if (state.rateLimited) return { state: "rate_limited", ...common, detail: state.alertText || undefined };
  if (state.terminalError) return { state: "error", ...common, detail: state.alertText || undefined };
  if (state.draftNonEmpty) {
    return { state: "error", ...common, detail: "ChatGPT composer contains an existing user draft; Goal automation will not overwrite it." };
  }
  if (state.generating) return { state: "generating", ...common };
  if (state.composerVisible) return { state: "idle", ...common };
  return { state: "error", ...common, detail: "ChatGPT page has no usable composer." };
}

async function sendPrompt(page: AttachedPage, prompt: string): Promise<GoalBrowserSendResult> {
  const state = await waitForDomState(page, CHATGPT_READY_TIMEOUT_MS, true);
  const snapshot = snapshotFromDomState(state, page.targetId);
  if (snapshot.state !== "idle") {
    throw new Error(`ChatGPT page is not idle (${snapshot.state}${snapshot.detail ? `: ${snapshot.detail}` : ""}).`);
  }
  const baseline = { userTurns: state.userTurns, assistantTurns: state.assistantTurns };
  const focused = await evaluate<{ ok: boolean; reason?: string }>(page, focusEmptyComposerExpression());
  if (!focused.ok) throw new Error(focused.reason ?? "ChatGPT composer is unavailable.");
  await page.cdp.send("Input.insertText", { text: prompt }, page.sessionId);
  const sendReadyDeadline = Date.now() + SEND_READY_TIMEOUT_MS;
  let sent: { ok: boolean; reason?: string } = { ok: false };
  do {
    sent = await evaluate<{ ok: boolean; reason?: string }>(page, clickSendExpression());
    if (sent.ok) break;
    await sleep(50);
  } while (Date.now() < sendReadyDeadline);
  if (!sent.ok) {
    throw new Error(sent.reason ?? `ChatGPT send button did not become ready within ${SEND_READY_TIMEOUT_MS}ms.`);
  }

  const deadline = Date.now() + SUBMISSION_TIMEOUT_MS;
  let latest = state;
  while (Date.now() < deadline) {
    latest = await readDomState(page);
    if (
      latest.userTurns > baseline.userTurns
      || latest.assistantTurns > baseline.assistantTurns
      || latest.generating
    ) {
      return {
        conversationUrl: latest.url,
        conversationKey: page.targetId,
      };
    }
    await sleep(100);
  }
  throw new Error("ChatGPT did not acknowledge the Goal continuation prompt within 12 seconds.");
}

function domStateExpression(): string {
  return `(() => {
    const visible = (selector) => Array.from(document.querySelectorAll(selector)).find((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return element.isConnected && bounds.width > 0 && bounds.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
    const composerSelectors = ${JSON.stringify(COMPOSER_SELECTORS)};
    const composer = composerSelectors.map(visible).find(Boolean);
    const stop = visible(${JSON.stringify(STOP_SELECTOR)});
    const alertNodes = Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error"], [class*="toast"]'))
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return element.isConnected && bounds.width > 0 && bounds.height > 0;
      })
      .slice(-8);
    const alertText = alertNodes.map((element) => element.textContent || '').join(String.fromCharCode(10)).trim().slice(0, 4000);
    const alertLower = alertText.toLowerCase();
    const pathname = location.pathname;
    const loginRequired = pathname === '/login' || pathname === '/auth' || pathname.startsWith('/auth/');
    const conversationLimit = /maximum length|conversation.{0,40}(limit|too long)|start a new chat|新建.{0,8}(聊天|对话)|对话.{0,20}(已达|达到).{0,20}(上限|限制)/i.test(alertText);
    const rateLimited = /rate limit|too many requests|try again later|usage limit|使用.{0,8}(上限|限制)|请求过于频繁/i.test(alertText);
    const terminalError = Boolean(visible('[data-testid="regenerate-thread-error-button"]'))
      || (/something went wrong|network error|response error|出错了|网络错误/i.test(alertLower) && !rateLimited);
    const draft = composer
      ? (('value' in composer ? composer.value : composer.innerText || composer.textContent || '') || '').trim()
      : '';
    const userTurns = Array.from(document.querySelectorAll(${JSON.stringify(USER_TURN_SELECTOR)}));
    const assistantTurns = Array.from(document.querySelectorAll(${JSON.stringify(ASSISTANT_TURN_SELECTOR)}));
    const visibleConversationChars = [...userTurns, ...assistantTurns]
      .reduce((total, element) => total + ((element.textContent || '').length), 0);
    return {
      url: location.href,
      composerVisible: Boolean(composer),
      generating: Boolean(stop),
      loginRequired,
      offline: navigator.onLine === false,
      conversationLimit,
      rateLimited,
      terminalError,
      draftNonEmpty: draft.length > 0,
      alertText,
      userTurns: userTurns.length,
      assistantTurns: assistantTurns.length,
      visibleConversationChars,
    };
  })()`;
}

function focusEmptyComposerExpression(): string {
  return `(() => {
    const visible = (selector) => Array.from(document.querySelectorAll(selector)).find((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const composer = ${JSON.stringify(COMPOSER_SELECTORS)}.map(visible).find(Boolean);
    if (!composer) return { ok: false, reason: 'ChatGPT composer is missing.' };
    const draft = (('value' in composer ? composer.value : composer.innerText || composer.textContent || '') || '').trim();
    if (draft) return { ok: false, reason: 'ChatGPT composer contains an existing user draft.' };
    composer.focus();
    return { ok: true };
  })()`;
}

function clickSendExpression(): string {
  return `(() => {
    const visible = (selector) => Array.from(document.querySelectorAll(selector)).find((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const composer = ${JSON.stringify(COMPOSER_SELECTORS)}.map(visible).find(Boolean);
    if (!composer) return { ok: false, reason: 'ChatGPT composer disappeared before send.' };
    const form = composer.closest('form');
    const button = form?.querySelector('[data-testid="send-button"]');
    if (!(button instanceof HTMLButtonElement)) return { ok: false, reason: 'ChatGPT send button is missing.' };
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'ChatGPT send button is disabled.' };
    button.click();
    return { ok: true };
  })()`;
}

function validateProfileId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(normalized) ? normalized : undefined;
}

function validateApiHost(value: string): string {
  const parsed = new URL(value.trim().replace(/\/$/, ""));
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) {
    throw new Error("RoxyBrowser API host must be a loopback HTTP URL.");
  }
  return parsed.origin;
}

export function sameConversationUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    if (a.origin !== b.origin || a.pathname !== b.pathname) return false;
    // AsterBridge deliberately uses Temporary Chat for some isolated web turns. Persistent Goals
    // must never mistake that surface for a normal durable ChatGPT conversation just because both
    // render at `/`. Other transient query parameters may differ without changing conversation
    // identity, but the temporary-chat boundary is semantic and must match exactly.
    return a.searchParams.get("temporary-chat") === b.searchParams.get("temporary-chat");
  } catch {
    return left === right;
  }
}

function isChatGptUrl(value: string): boolean {
  try {
    return new URL(value).origin === CHATGPT_ORIGIN;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
