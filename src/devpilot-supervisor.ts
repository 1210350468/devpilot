import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { loadConfig, type ServerConfig } from "./config.js";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import { terminateProcessTree } from "./process-platform.js";
import { createServer } from "./server.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { RequestObserver } from "./request-observer.js";
import { loadDevspaceFiles, setDevspaceConfigValues } from "./user-config.js";

const OPENAI_TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;
const CLOUDFLARE_QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const DEFAULT_CONTROL_HOST = "127.0.0.1";
const DEFAULT_CONTROL_PORT = 47680;
const DEFAULT_HEALTH_ADDR = "127.0.0.1:47683";
const DEFAULT_START_TIMEOUT_MS = 30_000;
const UI_BUILD_DIRECTORY = fileURLToPath(new URL("./ui/", import.meta.url));

export type DevPilotTunnelProvider = "none" | "cloudflare-quick" | "openai-secure";
export type ServiceState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface DevPilotSupervisorConfig {
  host: string;
  port: number;
  tunnelProvider: DevPilotTunnelProvider;
  cloudflaredCommand: string;
  tunnelClientCommand: string;
  tunnelId?: string;
  tunnelApiKey?: string;
  controlPlaneProxy?: string;
  tunnelHealthAddr: string;
  autoStart: boolean;
}

interface ServiceStatus {
  state: ServiceState;
  pid?: number;
  startedAt?: string;
  error?: string;
}

interface EventEntry {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface DevPilotStatus {
  product: "DevPilot";
  architecture: "upstream-first";
  supervisor: { status: "online"; host: string; port: number; pid: number };
  server: {
    status: "online" | "offline" | "starting" | "stopping" | "error";
    state: ServiceState;
    pid?: number;
    startedAt?: string;
    error?: string;
    toolMode: ServerConfig["toolMode"];
    tools: string[];
    host: string;
    port: number;
    localMcpUrl: string;
  };
  tunnel: {
    provider: DevPilotTunnelProvider;
    state: ServiceState;
    pid?: number;
    startedAt?: string;
    error?: string;
    tunnelId?: string;
    publicBaseUrl?: string;
    publicMcpUrl?: string;
    healthUrl?: string;
    ready?: boolean;
  };
  providers: ReturnType<typeof getLocalAgentProviderAvailabilitySnapshot>;
  requestObserver: { enabled: true; retained: number };
  events: EventEntry[];
}

export class DevPilotSupervisor {
  readonly app: Express;
  readonly config: DevPilotSupervisorConfig;
  private serverConfig: ServerConfig;
  private readonly requestObserver = new RequestObserver();
  private running?: ReturnType<typeof createServer>;
  private serverHttp?: Server;
  private serverStatus: ServiceStatus = { state: "stopped" };
  private tunnelProcess?: ChildProcessWithoutNullStreams;
  private tunnelPublicBaseUrl?: string;
  private tunnelStatus: ServiceStatus = { state: "stopped" };
  private controlHttp?: Server;
  private readonly events: EventEntry[] = [];

  constructor(serverConfig: ServerConfig, config = loadDevPilotSupervisorConfig(process.env)) {
    this.serverConfig = serverConfig;
    this.config = config;
    validateConfig(config);
    this.app = express();
    this.app.use(express.json({ limit: "64kb" }));
    this.registerRoutes();
  }

  async listen(): Promise<Server> {
    if (this.controlHttp) return this.controlHttp;
    this.controlHttp = await new Promise<Server>((resolve, reject) => {
      const http = this.app.listen(this.config.port, this.config.host, () => resolve(http));
      http.once("error", reject);
    });
    this.pushEvent("info", `Control Center listening on ${this.controlUrl()}`);
    if (this.config.autoStart) {
      void this.startServices().catch((error) => this.pushEvent("error", `Auto-start failed: ${errorMessage(error)}`));
    }
    return this.controlHttp;
  }

  async close(): Promise<void> {
    await this.stopServices();
    if (!this.controlHttp) return;
    const http = this.controlHttp;
    this.controlHttp = undefined;
    await closeHttpServer(http);
  }

  async startServices(): Promise<void> {
    if (this.config.tunnelProvider === "cloudflare-quick") {
      await this.startTunnel();
      await this.startServer();
      return;
    }
    await this.startServer();
    if (this.config.tunnelProvider === "openai-secure") await this.startTunnel();
  }

  async stopServices(): Promise<void> {
    await this.stopTunnel();
    await this.stopServer();
  }

  async restartServices(): Promise<void> {
    await this.stopServices();
    await this.startServices();
  }

  async startServer(): Promise<void> {
    if (["running", "starting"].includes(this.serverStatus.state)) return;
    this.serverStatus = { state: "starting" };
    this.pushEvent("info", "Starting upstream DevSpace MCP server.");
    let running: ReturnType<typeof createServer> | undefined;
    try {
      const loadedConfig = loadConfig();
      this.serverConfig = this.config.tunnelProvider === "cloudflare-quick" && this.tunnelPublicBaseUrl
        ? { ...loadedConfig, publicBaseUrl: this.tunnelPublicBaseUrl }
        : loadedConfig;
      running = createServer(this.serverConfig, {
        authMode: this.config.tunnelProvider === "openai-secure" ? "secure-tunnel" : "oauth",
        requestObserver: this.requestObserver,
      });
      const http = await new Promise<Server>((resolve, reject) => {
        const candidate = running!.app.listen(this.serverConfig.port, this.serverConfig.host, () => resolve(candidate));
        candidate.once("error", reject);
      });
      this.running = running;
      this.serverHttp = http;
      this.serverStatus = { state: "running", pid: process.pid, startedAt: new Date().toISOString() };
      this.pushEvent("info", `MCP server ready on ${this.localMcpUrl()} (${this.serverConfig.toolMode} surface).`);
    } catch (error) {
      await running?.close().catch(() => undefined);
      this.serverStatus = { state: "error", error: errorMessage(error) };
      this.pushEvent("error", `MCP server failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  async stopServer(): Promise<void> {
    if (!this.serverHttp || !this.running) {
      this.serverStatus = { state: "stopped" };
      return;
    }
    this.serverStatus = { ...this.serverStatus, state: "stopping" };
    const http = this.serverHttp;
    const running = this.running;
    this.serverHttp = undefined;
    this.running = undefined;
    try {
      await shutdownHttpServer(http, running.close);
      this.serverStatus = { state: "stopped" };
      this.pushEvent("info", "MCP server stopped.");
    } catch (error) {
      this.serverStatus = { state: "error", error: errorMessage(error) };
      this.pushEvent("error", `MCP server stop failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  async startTunnel(): Promise<void> {
    if (this.config.tunnelProvider === "none") return;
    if (["running", "starting"].includes(this.tunnelStatus.state)) return;
    if (this.config.tunnelProvider === "openai-secure" && this.serverStatus.state !== "running") await this.startServer();
    this.tunnelStatus = { state: "starting" };
    this.pushEvent("info", this.config.tunnelProvider === "cloudflare-quick"
      ? "Starting Cloudflare Quick Tunnel."
      : `Starting OpenAI Secure MCP Tunnel ${this.config.tunnelId}.`);
    try {
      if (this.config.tunnelProvider === "cloudflare-quick") {
        const launched = await spawnCloudflareQuickTunnel({
          command: this.config.cloudflaredCommand,
          localOrigin: localOrigin(this.serverConfig.host, this.serverConfig.port),
          timeoutMs: DEFAULT_START_TIMEOUT_MS,
        });
        this.tunnelProcess = launched.child;
        this.tunnelPublicBaseUrl = launched.publicBaseUrl;
        this.tunnelStatus = { state: "running", pid: launched.child.pid, startedAt: new Date().toISOString() };
        launched.child.once("exit", (code, signal) => {
          if (this.tunnelProcess !== launched.child) return;
          this.tunnelProcess = undefined;
          this.tunnelPublicBaseUrl = undefined;
          this.tunnelStatus = { state: "error", error: `cloudflared exited (${signal ?? code ?? "unknown"}).` };
          this.pushEvent("error", this.tunnelStatus.error!);
        });
        this.pushEvent("info", `Cloudflare Quick Tunnel is READY at ${launched.publicBaseUrl}.`);
        return;
      }

      const child = await spawnOpenAiSecureTunnel({
        command: this.config.tunnelClientCommand,
        tunnelId: this.config.tunnelId!,
        apiKey: this.config.tunnelApiKey!,
        controlPlaneProxy: this.config.controlPlaneProxy,
        mcpServerUrl: this.localMcpUrl(),
        healthListenAddr: this.config.tunnelHealthAddr,
        timeoutMs: DEFAULT_START_TIMEOUT_MS,
      });
      this.tunnelProcess = child;
      this.tunnelStatus = { state: "running", pid: child.pid, startedAt: new Date().toISOString() };
      child.once("exit", (code, signal) => {
        if (this.tunnelProcess !== child) return;
        this.tunnelProcess = undefined;
        this.tunnelStatus = { state: "error", error: `tunnel-client exited (${signal ?? code ?? "unknown"}).` };
        this.pushEvent("error", this.tunnelStatus.error!);
      });
      this.pushEvent("info", "OpenAI Secure MCP Tunnel is READY.");
    } catch (error) {
      this.tunnelStatus = { state: "error", error: errorMessage(error) };
      this.pushEvent("error", `Tunnel start failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  async stopTunnel(): Promise<void> {
    const child = this.tunnelProcess;
    if (!child) {
      this.tunnelPublicBaseUrl = undefined;
      this.tunnelStatus = { state: "stopped" };
      return;
    }
    this.tunnelStatus = { ...this.tunnelStatus, state: "stopping" };
    this.tunnelProcess = undefined;
    terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
    await waitForChildExit(child, 5_000);
    this.tunnelPublicBaseUrl = undefined;
    this.tunnelStatus = { state: "stopped" };
    this.pushEvent("info", `${this.config.tunnelProvider === "cloudflare-quick" ? "Cloudflare Quick Tunnel" : "OpenAI Secure MCP Tunnel"} stopped.`);
  }

  async status(): Promise<DevPilotStatus> {
    const tunnelReady = this.config.tunnelProvider === "openai-secure"
      ? await isReady(this.healthUrl())
      : this.config.tunnelProvider === "cloudflare-quick"
        ? this.tunnelStatus.state === "running" && Boolean(this.tunnelPublicBaseUrl)
        : undefined;
    const publicMcpUrl = this.config.tunnelProvider === "cloudflare-quick" && this.tunnelPublicBaseUrl
      ? new URL("/mcp", this.tunnelPublicBaseUrl).toString()
      : this.config.tunnelProvider === "openai-secure" && this.config.tunnelId
        ? `tunnel:${this.config.tunnelId}`
        : undefined;
    return {
      product: "DevPilot",
      architecture: "upstream-first",
      supervisor: { status: "online", host: this.config.host, port: this.config.port, pid: process.pid },
      server: {
        status: displayStatus(this.serverStatus.state),
        state: this.serverStatus.state,
        pid: this.serverStatus.pid,
        startedAt: this.serverStatus.startedAt,
        error: this.serverStatus.error,
        toolMode: this.serverConfig.toolMode,
        tools: toolsForMode(this.serverConfig.toolMode),
        host: this.serverConfig.host,
        port: this.serverConfig.port,
        localMcpUrl: this.localMcpUrl(),
      },
      tunnel: {
        provider: this.config.tunnelProvider,
        state: this.tunnelStatus.state,
        pid: this.tunnelProcess?.pid,
        startedAt: this.tunnelStatus.startedAt,
        error: this.tunnelStatus.error,
        tunnelId: this.config.tunnelId,
        publicBaseUrl: this.tunnelPublicBaseUrl,
        publicMcpUrl,
        healthUrl: this.config.tunnelProvider === "openai-secure" ? this.healthUrl() : undefined,
        ready: tunnelReady,
      },
      providers: getLocalAgentProviderAvailabilitySnapshot(process.env, this.serverConfig.subagents),
      requestObserver: {
        enabled: true,
        retained: this.requestObserver.list(200).length,
      },
      events: [...this.events].reverse(),
    };
  }

  private registerRoutes(): void {
    const localOnly = localOnlyMiddleware();
    const controlAction = requireControlActionHeader();
    this.app.get(/^\/$/, localOnly, (_req, res) => res.redirect(302, "/devpilot/"));
    this.app.get(/^\/devpilot$/, localOnly, (_req, res) => res.redirect(308, "/devpilot/"));
    this.app.use(
      "/devpilot/assets",
      localOnly,
      express.static(join(UI_BUILD_DIRECTORY, "assets"), {
        immutable: true,
        maxAge: "1y",
        fallthrough: false,
      }),
    );
    this.app.get(/^\/devpilot\/$/, localOnly, (_req, res) => {
      const htmlPath = join(UI_BUILD_DIRECTORY, "control-center.html");
      if (!existsSync(htmlPath)) {
        res.status(503).type("text/plain").send("DevPilot Control Center UI is not built yet. Run pnpm build.");
        return;
      }
      res.type("html").send(readFileSync(htmlPath, "utf8"));
    });
    this.app.get("/devpilot/api/status", localOnly, async (_req, res) => res.json(await this.status()));
    this.app.get("/devpilot/api/requests", localOnly, (req, res) => {
      const limit = queryPositiveInteger(req, "limit", 100, 200);
      const conversationScopeId = queryString(req, "conversationScopeId");
      res.json({ requests: this.requestObserver.list(limit, conversationScopeId) });
    });
    this.app.get("/devpilot/api/conversations", localOnly, (_req, res) => {
      res.json({ conversations: this.requestObserver.conversations() });
    });
    this.app.get("/devpilot/api/settings", localOnly, (_req, res) => {
      res.json(this.settingsPayload());
    });
    this.app.post("/devpilot/api/settings", localOnly, (req, res) => {
      try {
        const result = this.saveSettings(req.body as Record<string, unknown>);
        res.json(result);
      } catch (error) {
        res.status(400).json({ ok: false, error: errorMessage(error) });
      }
    });
    this.app.post("/devpilot/api/services/start", localOnly, controlAction, async (_req, res) => actionResponse(res, () => this.startServices(), () => this.status()));
    this.app.post("/devpilot/api/services/stop", localOnly, controlAction, async (_req, res) => actionResponse(res, () => this.stopServices(), () => this.status()));
    this.app.post("/devpilot/api/services/restart", localOnly, controlAction, async (_req, res) => actionResponse(res, () => this.restartServices(), () => this.status()));
  }

  private settingsPayload() {
    const files = loadDevspaceFiles();
    const saved = loadConfig();
    return {
      configPath: files.configPath,
      restartRequired: false,
      effective: {
        host: saved.host,
        port: saved.port,
        allowedRoots: saved.allowedRoots,
        authMode: this.config.tunnelProvider === "openai-secure" ? "secure-tunnel" : "oauth",
        toolMode: saved.toolMode,
        uiEnabled: saved.uiEnabled,
        artifactsEnabled: saved.artifactsEnabled,
        skillsEnabled: saved.skillsEnabled,
        subagentsEnabled: saved.subagents.enabled,
        publicBaseUrl: saved.publicBaseUrl,
        loggingRequests: saved.logging.requests,
        loggingToolCalls: saved.logging.toolCalls,
      },
      runtime: {
        host: this.serverConfig.host,
        port: this.serverConfig.port,
        allowedRoots: this.serverConfig.allowedRoots,
        toolMode: this.serverConfig.toolMode,
      },
      saved: files.config,
    };
  }

  private saveSettings(body: Record<string, unknown>) {
    const edits: Array<{ path: (string | number)[]; value: unknown }> = [];
    if (typeof body.host === "string" && body.host.trim()) {
      edits.push({ path: ["server", "host"], value: body.host.trim() });
    }
    if (typeof body.port === "number" && Number.isInteger(body.port) && body.port >= 1 && body.port <= 65_535) {
      edits.push({ path: ["server", "port"], value: body.port });
    }
    if (Array.isArray(body.allowedRoots) && body.allowedRoots.every((item) => typeof item === "string")) {
      edits.push({
        path: ["workspaces", "allowedRoots"],
        value: body.allowedRoots.map((item) => item.trim()).filter(Boolean),
      });
    }
    if (body.toolMode === "codex" || body.toolMode === "claude") {
      edits.push({ path: ["tools", "mode"], value: body.toolMode });
    }
    for (const [field, path] of [
      ["uiEnabled", ["ui", "enabled"]],
      ["artifactsEnabled", ["artifacts", "enabled"]],
      ["skillsEnabled", ["skills", "enabled"]],
      ["subagentsEnabled", ["subagents", "enabled"]],
      ["loggingRequests", ["logging", "requests"]],
      ["loggingToolCalls", ["logging", "toolCalls"]],
    ] as const) {
      if (typeof body[field] === "boolean") edits.push({ path: [...path], value: body[field] });
    }
    if (typeof body.publicBaseUrl === "string") {
      edits.push({ path: ["server", "publicBaseUrl"], value: body.publicBaseUrl.trim() || null });
    }
    if (edits.length === 0) throw new Error("No valid settings were provided.");
    const configPath = setDevspaceConfigValues(edits);
    this.pushEvent("info", "DevSpace settings saved; restart required to apply runtime changes.");
    return { ok: true, restartRequired: true, configPath, settings: this.settingsPayload() };
  }

  private pushEvent(level: EventEntry["level"], message: string): void {
    this.events.push({ at: new Date().toISOString(), level, message });
    if (this.events.length > 80) this.events.splice(0, this.events.length - 80);
  }

  private localMcpUrl(): string {
    return `${localOrigin(this.serverConfig.host, this.serverConfig.port)}/mcp`;
  }
  private controlUrl(): string { return localOrigin(this.config.host, this.config.port); }
  private healthUrl(): string { return openAiTunnelHealthBaseUrl(this.config.tunnelHealthAddr); }
}

export function loadDevPilotSupervisorConfig(env: NodeJS.ProcessEnv): DevPilotSupervisorConfig {
  const provider = (env.DEVPILOT_TUNNEL_PROVIDER?.trim() || "openai-secure") as DevPilotTunnelProvider;
  if (provider !== "none" && provider !== "cloudflare-quick" && provider !== "openai-secure") {
    throw new Error(`Unsupported DEVPILOT_TUNNEL_PROVIDER: ${provider}`);
  }
  return {
    host: env.DEVPILOT_CONTROL_HOST?.trim() || DEFAULT_CONTROL_HOST,
    port: positivePort(env.DEVPILOT_CONTROL_PORT, DEFAULT_CONTROL_PORT),
    tunnelProvider: provider,
    cloudflaredCommand: env.DEVPILOT_CLOUDFLARED?.trim() || "cloudflared",
    tunnelClientCommand: env.DEVPILOT_OPENAI_TUNNEL_CLIENT?.trim() || "tunnel-client",
    tunnelId: env.DEVPILOT_OPENAI_TUNNEL_ID?.trim() || undefined,
    tunnelApiKey: env.DEVPILOT_OPENAI_TUNNEL_API_KEY?.trim() || env.CONTROL_PLANE_API_KEY?.trim() || undefined,
    controlPlaneProxy: env.DEVPILOT_OPENAI_CONTROL_PLANE_PROXY?.trim() || env.CONTROL_PLANE_HTTP_PROXY?.trim() || undefined,
    tunnelHealthAddr: env.DEVPILOT_OPENAI_TUNNEL_HEALTH_ADDR?.trim() || DEFAULT_HEALTH_ADDR,
    autoStart: env.DEVPILOT_AUTOSTART === undefined ? true : parseBoolean(env.DEVPILOT_AUTOSTART),
  };
}

export function parseCloudflareQuickTunnelUrl(output: string): string | undefined {
  const matches = output.match(CLOUDFLARE_QUICK_URL);
  return matches?.[matches.length - 1]?.replace(/\/$/, "");
}

export async function spawnCloudflareQuickTunnel(input: { command: string; localOrigin: string; timeoutMs: number }): Promise<{ child: ChildProcessWithoutNullStreams; publicBaseUrl: string }> {
  const child = spawn(input.command, ["tunnel", "--no-autoupdate", "--url", input.localOrigin], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32", env: process.env,
  });
  child.stdin.end();
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
      reject(new Error(`Cloudflare Quick Tunnel did not publish a URL within ${input.timeoutMs}ms.`));
    }, input.timeoutMs);
    timer.unref();
    const inspect = (chunk: Buffer) => {
      if (settled) return;
      output = (output + chunk.toString("utf8")).slice(-32_000);
      const publicBaseUrl = parseCloudflareQuickTunnelUrl(output);
      if (!publicBaseUrl) return;
      settled = true;
      clearTimeout(timer);
      resolve({ child, publicBaseUrl });
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Unable to start cloudflared: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited before publishing a URL (${signal ?? code ?? "unknown"}).`));
    });
  });
}

export async function spawnOpenAiSecureTunnel(input: { command: string; tunnelId: string; apiKey: string; controlPlaneProxy?: string; mcpServerUrl: string; healthListenAddr: string; timeoutMs: number }): Promise<ChildProcessWithoutNullStreams> {
  const healthBaseUrl = openAiTunnelHealthBaseUrl(input.healthListenAddr);
  const noProxy = appendNoProxy(process.env.NO_PROXY ?? process.env.no_proxy, ["127.0.0.1", "localhost", "::1"]);
  const child = spawn(input.command, ["run"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
    env: { ...process.env, CONTROL_PLANE_API_KEY: input.apiKey, CONTROL_PLANE_TUNNEL_ID: input.tunnelId, ...(input.controlPlaneProxy ? { CONTROL_PLANE_HTTP_PROXY: input.controlPlaneProxy } : {}), MCP_SERVER_URL: input.mcpServerUrl, HEALTH_LISTEN_ADDR: input.healthListenAddr, NO_PROXY: noProxy, no_proxy: noProxy },
  });
  child.stdin.end();
  let output = "";
  const capture = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-16_000); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`tunnel-client exited before READY: ${redactSecret(output.trim(), input.apiKey)}`);
    if (await isReady(healthBaseUrl)) return child;
    await delay(250);
  }
  terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
  throw new Error(`OpenAI Secure MCP Tunnel did not become ready within ${input.timeoutMs}ms.`);
}

function controlCenterHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DevPilot Control Center</title><style>:root{color-scheme:light;background:#f5f7fb;color:#162033;font-family:Inter,ui-sans-serif,system-ui,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#e8f1ff,transparent 34%),#f5f7fb}.wrap{max-width:1120px;margin:0 auto;padding:32px 22px 48px}.top{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:24px}.brand h1{margin:0;font-size:30px}.brand p{margin:6px 0 0;color:#667085}.pill{padding:8px 12px;border-radius:999px;background:#e9f9ef;color:#137a3c;font-weight:700}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card{background:rgba(255,255,255,.92);border:1px solid #e6eaf0;border-radius:18px;padding:18px;box-shadow:0 12px 30px rgba(36,55,87,.06)}.card h2{font-size:15px;margin:0 0 14px;color:#667085}.value{font-size:24px;font-weight:800}.sub{font-size:13px;color:#667085;margin-top:8px;word-break:break-all}.ok{color:#138a4b}.bad{color:#c43232}.warn{color:#b56a00}.wide{grid-column:span 2}.actions{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}.btn{border:0;border-radius:12px;padding:11px 16px;font-weight:700;cursor:pointer}.primary{background:#1f6feb;color:white}.secondary{background:white;color:#25324a;border:1px solid #dce2ea}.danger{background:#fff0f0;color:#b42318;border:1px solid #ffd0d0}.tools{display:flex;flex-wrap:wrap;gap:8px}.tool{background:#eef4ff;color:#285ea8;border-radius:9px;padding:6px 9px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.provider{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eef1f5}.events{max-height:280px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.event{padding:7px 0;border-bottom:1px solid #eef1f5}.event time{color:#98a2b3;margin-right:8px}@media(max-width:800px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}.top{align-items:flex-start;flex-direction:column}}</style></head><body><div class="wrap"><div class="top"><div class="brand"><h1>DevPilot Control Center</h1><p>Upstream-first DevSpace + OpenAI Secure MCP Tunnel</p></div><div id="healthPill" class="pill">Checking…</div></div><div class="actions"><button class="btn primary" onclick="act('start')">启动全部</button><button class="btn secondary" onclick="act('restart')">重启全部</button><button class="btn danger" onclick="act('stop')">停止全部</button><button class="btn secondary" onclick="refresh()">立即刷新</button></div><div class="grid"><section class="card"><h2>MCP Server</h2><div id="serverState" class="value">-</div><div id="serverMeta" class="sub"></div></section><section class="card"><h2>OpenAI Tunnel</h2><div id="tunnelState" class="value">-</div><div id="tunnelMeta" class="sub"></div></section><section class="card"><h2>Tool Surface</h2><div id="toolMode" class="value">-</div><div id="tools" class="tools" style="margin-top:10px"></div></section><section class="card wide"><h2>Providers</h2><div id="providers"></div></section><section class="card"><h2>Runtime</h2><div id="runtime" class="sub"></div></section><section class="card wide"><h2>Recent lifecycle events</h2><div id="events" class="events"></div></section></div></div><script>const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function stateClass(s){return s==='running'||s==='online'?'ok':s==='error'?'bad':s==='starting'||s==='stopping'?'warn':''}async function refresh(){try{const r=await fetch('/devpilot/api/status',{cache:'no-store'});const s=await r.json();document.getElementById('healthPill').textContent=s.server.status==='online'&&s.tunnel.ready?'READY':'ATTENTION';document.getElementById('healthPill').className='pill '+(s.server.status==='online'&&s.tunnel.ready?'ok':'warn');document.getElementById('serverState').innerHTML='<span class="'+stateClass(s.server.state)+'">'+esc(s.server.state)+'</span>';document.getElementById('serverMeta').innerHTML=esc(s.server.localMcpUrl)+'<br>PID '+esc(s.server.pid??'-');document.getElementById('tunnelState').innerHTML='<span class="'+stateClass(s.tunnel.state)+'">'+esc(s.tunnel.state)+'</span>';document.getElementById('tunnelMeta').innerHTML='ready='+esc(s.tunnel.ready)+'<br>'+esc(s.tunnel.tunnelId??'no tunnel')+'<br>'+esc(s.tunnel.healthUrl??'');document.getElementById('toolMode').textContent=s.server.toolMode;document.getElementById('tools').innerHTML=s.server.tools.map(x=>'<span class="tool">'+esc(x)+'</span>').join('');document.getElementById('providers').innerHTML=s.providers.map(p=>'<div class="provider"><span>'+esc(p.name)+'</span><strong class="'+(p.available?'ok':'bad')+'">'+(p.available?'available':'unavailable')+'</strong></div>').join('');document.getElementById('runtime').innerHTML='Supervisor PID '+esc(s.supervisor.pid)+'<br>Control '+esc(s.supervisor.host)+':'+esc(s.supervisor.port)+'<br>Architecture '+esc(s.architecture);document.getElementById('events').innerHTML=s.events.map(e=>'<div class="event"><time>'+esc(new Date(e.at).toLocaleTimeString())+'</time>'+esc(e.message)+'</div>').join('');}catch(e){document.getElementById('healthPill').textContent='OFFLINE';document.getElementById('healthPill').className='pill bad'}}async function act(name){await fetch('/devpilot/api/services/'+name,{method:'POST',headers:{'x-devpilot-control':'1'}});await refresh()}refresh();setInterval(refresh,2000);</script></body></html>`;
}

function toolsForMode(mode: ServerConfig["toolMode"]): string[] { return mode === "codex" ? ["open_workspace", "read", "show_changes", "apply_patch", "exec_command", "write_stdin"] : ["open_workspace", "read", "show_changes", "write", "edit", "bash"]; }
function queryString(req: Request, key: string): string | undefined { const value = req.query[key]; return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function queryPositiveInteger(req: Request, key: string, fallback: number, maximum: number): number { const value = queryString(req, key); if (!value) return fallback; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) return fallback; return Math.min(parsed, maximum); }
function localOnlyMiddleware() { return (req: Request, res: Response, next: NextFunction): void => { const address = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? ""; if (address !== "127.0.0.1" && address !== "::1") { res.status(403).json({ error: "DevPilot Control Center is loopback-only." }); return; } next(); }; }
function requireControlActionHeader() { return (req: Request, res: Response, next: NextFunction): void => { if (req.header("x-devpilot-control") !== "1") { res.status(403).json({ error: "DevPilot control action header is required." }); return; } next(); }; }
async function actionResponse(res: Response, action: () => Promise<void>, status: () => Promise<DevPilotStatus>): Promise<void> { try { await action(); res.json(await status()); } catch (error) { res.status(500).json({ error: errorMessage(error), status: await status() }); } }
function validateConfig(config: DevPilotSupervisorConfig): void { if (config.tunnelProvider !== "openai-secure") return; if (!config.tunnelId || !OPENAI_TUNNEL_ID.test(config.tunnelId)) throw new Error("OpenAI Secure MCP Tunnel requires tunnel_<32 lowercase hex>."); if (!config.tunnelApiKey) throw new Error("OpenAI Secure MCP Tunnel requires a runtime API key."); openAiTunnelHealthBaseUrl(config.tunnelHealthAddr); }
function positivePort(value: string | undefined, fallback: number): number { if (!value) return fallback; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`Invalid port: ${value}`); return parsed; }
function parseBoolean(value: string): boolean { return ["1", "true", "yes", "on"].includes(value.toLowerCase()); }
function localOrigin(host: string, port: number): string { const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host; const formatted = localHost.includes(":") && !localHost.startsWith("[") ? `[${localHost}]` : localHost; return `http://${formatted}:${port}`; }
function openAiTunnelHealthBaseUrl(value: string): string { const trimmed = value.trim(); const candidate = trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `http://${trimmed.startsWith(":") ? `127.0.0.1${trimmed}` : trimmed}`; const url = new URL(candidate); const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, ""); if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) throw new Error("Tunnel health listener must be loopback-only."); url.pathname = ""; url.search = ""; url.hash = ""; return url.toString().replace(/\/$/, ""); }
function appendNoProxy(current: string | undefined, required: string[]): string { const values = (current ?? "").split(",").map((value) => value.trim()).filter(Boolean); for (const value of required) if (!values.includes(value)) values.push(value); return values.join(","); }
function redactSecret(value: string, secret: string): string { return value.split(secret).join("[REDACTED]"); }
function displayStatus(state: ServiceState): DevPilotStatus["server"]["status"] { if (state === "running") return "online"; if (state === "stopped") return "offline"; return state; }
async function isReady(baseUrl: string): Promise<boolean> { try { const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(800) }); return response.ok; } catch { return false; } }
async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise<void>((resolve) => { const timer = setTimeout(resolve, timeoutMs); timer.unref(); child.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
async function closeHttpServer(server: Server): Promise<void> { if (!server.listening) return; await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); }); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
