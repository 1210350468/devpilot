import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { ServerConfig } from "./config.js";
import { localControlCenterOnly } from "./control-center.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";
import { createLocalAgentClient, type LocalAgentClient } from "./local-agent-client.js";
import { terminateProcessTree } from "./process-platform.js";
import { shutdownHttpServer } from "./server-shutdown.js";

const DEFAULT_CONTROL_HOST = "127.0.0.1";
const DEFAULT_CONTROL_PORT = 7680;
const DEFAULT_TUNNEL_START_TIMEOUT_MS = 30_000;
const DEFAULT_OPENAI_TUNNEL_HEALTH_ADDR = "127.0.0.1:7683";
const CLOUDFLARE_QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const OPENAI_TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;

export type DevPilotTunnelProvider = "none" | "external" | "cloudflare-quick" | "openai-secure" | "managed-command";
export type DevPilotServerOwnership = "none" | "managed" | "external";
export type ManagedServiceState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface DevPilotSupervisorConfig {
  host: string;
  port: number;
  tunnelProvider: DevPilotTunnelProvider;
  cloudflaredCommand: string;
  openAiTunnelClientCommand: string;
  openAiTunnelId?: string;
  openAiTunnelApiKey?: string;
  openAiControlPlaneProxy?: string;
  openAiTunnelHealthAddr: string;
  managedTunnelCommand?: string;
  managedTunnelArgs: string[];
  managedTunnelPublicBaseUrl?: string;
  autoStart: boolean;
}

export interface ManagedServiceStatus {
  state: ManagedServiceState;
  pid?: number;
  startedAt?: string;
  error?: string;
}

export interface DevPilotSupervisorStatus {
  product: "DevPilot";
  supervisor: {
    status: "online";
    host: string;
    port: number;
  };
  server: {
    status: "online" | "offline" | "starting" | "stopping" | "error";
    state: ManagedServiceState;
    ownership: DevPilotServerOwnership;
    managed: boolean;
    pid?: number;
    startedAt?: string;
    error?: string;
    toolMode: string;
    host: string;
    port: number;
    localMcpUrl: string;
    publicMcpUrl: string;
    publicEndpointConfigured: boolean;
  };
  tunnel: {
    provider: DevPilotTunnelProvider;
    managed: boolean;
    state: ManagedServiceState | "external";
    pid?: number;
    publicBaseUrl?: string;
    tunnelId?: string;
    healthUrl?: string;
    ready?: boolean;
    error?: string;
  };
  daemon: {
    available: boolean;
    state: string;
    pid?: number;
    startedAt?: string;
    activeTurns?: number;
    runtimeCount?: number;
    clientConnections?: number;
    reason?: string;
  };
  providers: Array<{
    name: string;
    available: boolean;
    note?: string;
    reason?: string;
  }>;
}

interface RunningDevspaceServer {
  app: Express;
  close(): Promise<void>;
  localAgentProviders: LocalAgentProviderAvailability[];
}

interface SupervisorOptions {
  serverConfig: ServerConfig;
  supervisorConfig?: Partial<DevPilotSupervisorConfig>;
  uiBuildDirectory?: string;
  localAgentClient?: LocalAgentClient;
  providers?: LocalAgentProviderAvailability[];
  spawnTunnel?: typeof spawnCloudflareQuickTunnel;
  spawnOpenAiTunnel?: typeof spawnOpenAiSecureTunnel;
}

export class DevPilotSupervisor {
  readonly app: Express;
  readonly config: DevPilotSupervisorConfig;
  private readonly serverConfig: ServerConfig;
  private readonly uiBuildDirectory: string;
  private readonly localAgentClient: LocalAgentClient;
  private readonly providers: LocalAgentProviderAvailability[];
  private readonly spawnTunnel: typeof spawnCloudflareQuickTunnel;
  private readonly spawnOpenAiTunnel: typeof spawnOpenAiSecureTunnel;
  private running?: RunningDevspaceServer;
  private serverHttp?: Server;
  private serverState: ManagedServiceStatus = { state: "stopped" };
  private serverOwnership: DevPilotServerOwnership = "none";
  private externalToolMode = "external";
  private tunnelProcess?: ChildProcessWithoutNullStreams;
  private tunnelState: ManagedServiceStatus = { state: "stopped" };
  private tunnelPublicBaseUrl?: string;
  private controlHttp?: Server;
  private serverOperation?: Promise<void>;
  private tunnelOperation?: Promise<void>;

  constructor(options: SupervisorOptions) {
    this.serverConfig = options.serverConfig;
    this.config = {
      ...loadDevPilotSupervisorConfig(process.env, options.serverConfig),
      ...options.supervisorConfig,
    };
    validateSupervisorConfig(this.config);
    this.uiBuildDirectory = options.uiBuildDirectory ?? fileURLToPath(new URL("../dist/ui", import.meta.url));
    this.localAgentClient = options.localAgentClient ?? createLocalAgentClient(options.serverConfig);
    this.providers = options.providers ?? getLocalAgentProviderAvailabilitySnapshot();
    this.spawnTunnel = options.spawnTunnel ?? spawnCloudflareQuickTunnel;
    this.spawnOpenAiTunnel = options.spawnOpenAiTunnel ?? spawnOpenAiSecureTunnel;
    this.app = express();
    this.app.use(express.json({ limit: "64kb" }));
    this.registerRoutes();
  }

  async listen(): Promise<Server> {
    if (this.controlHttp) return this.controlHttp;
    this.controlHttp = await new Promise<Server>((resolve, reject) => {
      const server = this.app.listen(this.config.port, this.config.host, () => resolve(server));
      server.once("error", reject);
    });
    if (this.config.autoStart) {
      void this.startServices().catch((error) => {
        this.serverState = { state: "error", error: errorMessage(error) };
      });
    }
    return this.controlHttp;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.stopServer(), this.stopTunnel()]);
    if (!this.controlHttp) return;
    const controlHttp = this.controlHttp;
    this.controlHttp = undefined;
    await closeHttpServer(controlHttp);
  }

  async startServices(): Promise<void> {
    if (this.config.tunnelProvider === "openai-secure") {
      await this.startServer();
      await this.startTunnel();
      return;
    }
    if (isManagedTunnelProvider(this.config.tunnelProvider)) await this.startTunnel();
    await this.startServer();
  }

  async stopServices(): Promise<void> {
    await this.stopServer();
    await this.stopTunnel();
  }

  async startServer(): Promise<void> {
    if (this.serverOwnership === "external") await this.refreshExternalServerState();
    if (this.serverState.state === "running") return;
    if (this.serverOperation) return this.serverOperation;
    this.serverOperation = this.startServerInternal().finally(() => {
      this.serverOperation = undefined;
    });
    return this.serverOperation;
  }

  async stopServer(): Promise<void> {
    if (this.serverOperation) await this.serverOperation.catch(() => undefined);
    if (this.serverOwnership === "external") return;
    if (!this.serverHttp || !this.running) {
      this.serverOwnership = "none";
      this.serverState = { state: "stopped" };
      return;
    }
    this.serverState = { ...this.serverState, state: "stopping", error: undefined };
    const http = this.serverHttp;
    const running = this.running;
    this.serverHttp = undefined;
    this.running = undefined;
    try {
      await shutdownHttpServer(http, running.close);
      this.serverOwnership = "none";
      this.serverState = { state: "stopped" };
    } catch (error) {
      this.serverState = { state: "error", error: errorMessage(error) };
      throw error;
    }
  }

  async startTunnel(): Promise<void> {
    if (this.config.tunnelProvider === "none") {
      this.tunnelState = { state: "stopped" };
      return;
    }
    if (this.config.tunnelProvider === "external") {
      this.tunnelPublicBaseUrl = this.serverConfig.publicBaseUrl;
      this.tunnelState = { state: "running" };
      return;
    }
    if (this.tunnelState.state === "running") return;
    if (this.tunnelOperation) return this.tunnelOperation;
    const restartServer = this.serverState.state === "running" && this.config.tunnelProvider !== "openai-secure";
    this.tunnelOperation = this.startTunnelInternal().finally(() => {
      this.tunnelOperation = undefined;
    });
    await this.tunnelOperation;
    if (restartServer) await this.restartServerForEndpointChange();
  }

  async stopTunnel(): Promise<void> {
    if (this.tunnelOperation) await this.tunnelOperation.catch(() => undefined);
    if (!isManagedTunnelProvider(this.config.tunnelProvider)) {
      this.tunnelState = this.config.tunnelProvider === "external" ? { state: "running" } : { state: "stopped" };
      return;
    }
    const child = this.tunnelProcess;
    if (!child) {
      this.tunnelState = { state: "stopped" };
      this.tunnelPublicBaseUrl = undefined;
      return;
    }
    this.tunnelState = { ...this.tunnelState, state: "stopping", error: undefined };
    this.tunnelProcess = undefined;
    terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
    await waitForChildExit(child, 5_000).catch(() => undefined);
    this.tunnelState = { state: "stopped" };
    this.tunnelPublicBaseUrl = undefined;
    if (this.serverState.state === "running" && this.config.tunnelProvider !== "openai-secure") {
      await this.restartServerForEndpointChange();
    }
  }

  async status(): Promise<DevPilotSupervisorStatus> {
    await this.refreshExternalServerState();
    const daemon = await this.localAgentClient.status();
    const daemonStatus = daemon.isOk()
      ? {
          available: true,
          state: daemon.value.state,
          pid: daemon.value.pid,
          startedAt: daemon.value.startedAt,
          activeTurns: daemon.value.activeTurns,
          runtimeCount: daemon.value.runtimeCount,
          clientConnections: daemon.value.clientConnections,
        }
      : {
          available: false,
          state: "offline",
          reason: daemon.error.message,
        };
    const publicBaseUrl = this.effectivePublicBaseUrl();
    const secureTunnel = this.config.tunnelProvider === "openai-secure";
    const secureTunnelHealthUrl = secureTunnel ? openAiTunnelHealthBaseUrl(this.config.openAiTunnelHealthAddr) : undefined;
    const secureTunnelReady = secureTunnel && this.tunnelState.state === "running";
    return {
      product: "DevPilot",
      supervisor: {
        status: "online",
        host: this.config.host,
        port: this.config.port,
      },
      server: {
        status: displayServerStatus(this.serverState.state),
        state: this.serverState.state,
        ownership: this.serverOwnership,
        managed: this.serverOwnership === "managed",
        pid: this.serverOwnership === "managed" ? process.pid : undefined,
        startedAt: this.serverState.startedAt,
        error: this.serverState.error,
        toolMode: this.serverOwnership === "external" ? this.externalToolMode : this.serverConfig.toolMode,
        host: this.serverConfig.host,
        port: this.serverConfig.port,
        localMcpUrl: localMcpUrl(this.serverConfig),
        publicMcpUrl: secureTunnel && this.config.openAiTunnelId
          ? `tunnel:${this.config.openAiTunnelId}`
          : new URL("/mcp", publicBaseUrl).toString(),
        publicEndpointConfigured: secureTunnel ? secureTunnelReady : !isLocalUrl(publicBaseUrl),
      },
      tunnel: {
        provider: this.config.tunnelProvider,
        managed: isManagedTunnelProvider(this.config.tunnelProvider),
        state: this.config.tunnelProvider === "external" ? "external" : this.tunnelState.state,
        pid: this.tunnelProcess?.pid,
        publicBaseUrl: this.tunnelPublicBaseUrl ?? (
          this.config.tunnelProvider === "external"
            ? this.serverConfig.publicBaseUrl
            : this.config.tunnelProvider === "managed-command"
              ? this.config.managedTunnelPublicBaseUrl
              : undefined
        ),
        tunnelId: secureTunnel ? this.config.openAiTunnelId : undefined,
        healthUrl: secureTunnelHealthUrl,
        ready: secureTunnel ? secureTunnelReady : undefined,
        error: this.tunnelState.error,
      },
      daemon: daemonStatus,
      providers: this.providers.map((provider) => ({
        name: provider.name,
        available: provider.available,
        note: provider.note,
        reason: provider.reason,
      })),
    };
  }

  private async startServerInternal(): Promise<void> {
    this.serverState = { state: "starting" };
    const existing = await probeCompatibleDevspaceServer(this.serverConfig);
    if (existing) {
      this.attachExternalServer(existing);
      return;
    }
    let running: RunningDevspaceServer | undefined;
    try {
      const dynamicConfig = withPublicBaseUrl(this.serverConfig, this.effectivePublicBaseUrl());
      const { createServer } = await import("./server.js");
      running = createServer(dynamicConfig) as RunningDevspaceServer;
      const http = await new Promise<Server>((resolve, reject) => {
        const candidate = running!.app.listen(dynamicConfig.port, dynamicConfig.host, () => resolve(candidate));
        candidate.once("error", reject);
      });
      this.running = running;
      this.serverHttp = http;
      this.serverOwnership = "managed";
      this.externalToolMode = "external";
      this.serverState = {
        state: "running",
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
    } catch (error) {
      await running?.close().catch(() => undefined);
      const racedExisting = await probeCompatibleDevspaceServer(this.serverConfig);
      if (racedExisting) {
        this.attachExternalServer(racedExisting);
        return;
      }
      this.serverOwnership = "none";
      this.serverState = { state: "error", error: errorMessage(error) };
      throw error;
    }
  }

  private attachExternalServer(probe: CompatibleDevspaceProbe): void {
    this.running = undefined;
    this.serverHttp = undefined;
    this.serverOwnership = "external";
    this.externalToolMode = probe.toolMode ?? "external";
    this.serverState = { state: "running" };
  }

  private async refreshExternalServerState(): Promise<void> {
    if (this.serverOwnership === "managed") return;
    const probe = await probeCompatibleDevspaceServer(this.serverConfig);
    if (probe) {
      this.attachExternalServer(probe);
      return;
    }
    if (this.serverOwnership === "external") {
      this.serverOwnership = "none";
      this.externalToolMode = "external";
      this.serverState = { state: "stopped" };
    }
  }

  private async restartServerForEndpointChange(): Promise<void> {
    await this.stopServer();
    await this.startServer();
  }

  private async startTunnelInternal(): Promise<void> {
    this.tunnelState = { state: "starting" };
    try {
      const launched = this.config.tunnelProvider === "managed-command"
        ? {
            child: await spawnManagedTunnelCommand({
              command: this.config.managedTunnelCommand!,
              args: this.config.managedTunnelArgs,
            }),
            publicBaseUrl: this.config.managedTunnelPublicBaseUrl!,
          }
        : this.config.tunnelProvider === "openai-secure"
          ? await this.spawnOpenAiTunnel({
              command: this.config.openAiTunnelClientCommand,
              tunnelId: this.config.openAiTunnelId!,
              apiKey: this.config.openAiTunnelApiKey!,
              controlPlaneProxy: this.config.openAiControlPlaneProxy,
              mcpServerUrl: localMcpUrl(this.serverConfig),
              healthListenAddr: this.config.openAiTunnelHealthAddr,
              timeoutMs: DEFAULT_TUNNEL_START_TIMEOUT_MS,
            })
          : await this.spawnTunnel({
              command: this.config.cloudflaredCommand,
              localOrigin: localOrigin(this.serverConfig),
              timeoutMs: DEFAULT_TUNNEL_START_TIMEOUT_MS,
            });

      this.tunnelProcess = launched.child;
      this.tunnelPublicBaseUrl = "publicBaseUrl" in launched ? launched.publicBaseUrl : undefined;
      this.tunnelState = {
        state: "running",
        pid: launched.child.pid,
        startedAt: new Date().toISOString(),
      };
      launched.child.once("exit", (code, signal) => {
        if (this.tunnelProcess !== launched.child) return;
        this.tunnelProcess = undefined;
        this.tunnelState = {
          state: "error",
          error: `${this.config.tunnelProvider} tunnel exited (${signal ?? code ?? "unknown"}).`,
        };
      });
    } catch (error) {
      this.tunnelState = { state: "error", error: errorMessage(error) };
      throw error;
    }
  }

  private effectivePublicBaseUrl(): string {
    if (this.config.tunnelProvider === "cloudflare-quick") {
      return this.tunnelPublicBaseUrl ?? localOrigin(this.serverConfig);
    }
    if (this.config.tunnelProvider === "managed-command") {
      return this.tunnelPublicBaseUrl ?? this.config.managedTunnelPublicBaseUrl!;
    }
    return this.serverConfig.publicBaseUrl;
  }

  private registerRoutes(): void {
    const localOnly = localControlCenterOnly();
    const controlAction = requireControlActionHeader();
    this.app.get(/^\/$/, localOnly, (_req, res) => res.redirect(302, "/devpilot/"));
    this.app.get(/^\/devpilot$/, localOnly, (_req, res) => res.redirect(308, "/devpilot/"));
    this.app.use(
      "/devpilot/assets",
      localOnly,
      express.static(join(this.uiBuildDirectory, "assets"), {
        immutable: true,
        maxAge: "1y",
        fallthrough: false,
      }),
    );
    this.app.get("/devpilot/", localOnly, (_req, res) => {
      const htmlPath = join(this.uiBuildDirectory, "control-center.html");
      if (!existsSync(htmlPath)) {
        res.status(503).type("text/plain").send("DevPilot Control Center UI is not built yet. Run npm run build.");
        return;
      }
      res.sendFile(htmlPath);
    });
    this.app.get("/devpilot/api/status", localOnly, async (_req, res) => {
      res.json(await this.status());
    });
    this.app.get("/devpilot/api/requests", localOnly, async (req, res) => {
      await this.proxyServerJson(req, res, "/devpilot/api/requests");
    });
    this.app.get("/devpilot/api/conversations", localOnly, async (req, res) => {
      await this.proxyServerJson(req, res, "/devpilot/api/conversations");
    });
    this.app.get("/devpilot/api/settings", localOnly, async (req, res) => {
      await this.proxyServerJson(req, res, "/devpilot/api/settings");
    });
    this.app.post("/devpilot/api/settings", localOnly, async (req, res) => {
      await this.proxyServerJson(req, res, "/devpilot/api/settings", "POST");
    });
    this.app.post("/devpilot/api/services/start", localOnly, controlAction, async (_req, res) => {
      await actionResponse(res, () => this.startServices(), () => this.status());
    });
    this.app.post("/devpilot/api/services/stop", localOnly, controlAction, async (_req, res) => {
      await actionResponse(res, () => this.stopServices(), () => this.status());
    });
    this.app.post("/devpilot/api/server/start", localOnly, controlAction, async (_req, res) => {
      await actionResponse(res, () => this.startServer(), () => this.status());
    });
    this.app.post("/devpilot/api/server/stop", localOnly, controlAction, async (_req, res) => {
      await actionResponse(res, () => this.stopServer(), () => this.status());
    });
    this.app.post("/devpilot/api/tunnel/start", localOnly, controlAction, async (_req, res) => {
      await actionResponse(res, () => this.startTunnel(), () => this.status());
    });
    this.app.post("/devpilot/api/tunnel/stop", localOnly, controlAction, async (_req, res) => {
      await actionResponse(res, () => this.stopTunnel(), () => this.status());
    });
    this.app.post("/devpilot/api/daemon/start", localOnly, controlAction, async (_req, res) => {
      await actionResultResponse(res, this.localAgentClient.ensureReady(), () => this.status());
    });
    this.app.post("/devpilot/api/daemon/stop", localOnly, controlAction, async (_req, res) => {
      await actionResultResponse(res, this.localAgentClient.stop(), () => this.status());
    });
  }

  private async proxyServerJson(
    req: Request,
    res: Response,
    path: string,
    method: "GET" | "POST" = "GET",
  ): Promise<void> {
    await this.refreshExternalServerState();
    if (this.serverState.state !== "running") {
      res.status(503).json({ error: "DevPilot MCP server is offline." });
      return;
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string") query.set(key, value);
    }
    const suffix = query.size ? `?${query.toString()}` : "";
    try {
      const response = await fetch(`${localOrigin(this.serverConfig)}${path}${suffix}`, {
        method,
        headers: {
          host: loopbackHostHeader(this.serverConfig),
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        body: method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
      });
      const text = await response.text();
      res.status(response.status);
      res.type(response.headers.get("content-type") ?? "application/json");
      res.send(text);
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  }
}

export function loadDevPilotSupervisorConfig(
  env: NodeJS.ProcessEnv,
  serverConfig: Pick<ServerConfig, "publicBaseUrl">,
): DevPilotSupervisorConfig {
  const provider = tunnelProvider(env.DEVPILOT_TUNNEL_PROVIDER, serverConfig.publicBaseUrl);
  const managedTunnelCommand = env.DEVPILOT_TUNNEL_COMMAND?.trim() || undefined;
  const managedTunnelPublicBaseUrl = normalizeOptionalUrl(env.DEVPILOT_TUNNEL_PUBLIC_BASE_URL);
  const openAiTunnelId = env.DEVPILOT_OPENAI_TUNNEL_ID?.trim() || undefined;
  const openAiTunnelApiKey = env.DEVPILOT_OPENAI_TUNNEL_API_KEY?.trim() || env.CONTROL_PLANE_API_KEY?.trim() || undefined;
  const openAiControlPlaneProxy = env.DEVPILOT_OPENAI_CONTROL_PLANE_PROXY?.trim() || env.CONTROL_PLANE_HTTP_PROXY?.trim() || undefined;
  const managedTunnelArgs = parseJsonStringArray(env.DEVPILOT_TUNNEL_ARGS_JSON, "DEVPILOT_TUNNEL_ARGS_JSON");
  if (provider === "managed-command") {
    if (!managedTunnelCommand) {
      throw new Error("DEVPILOT_TUNNEL_COMMAND is required for managed-command tunnels.");
    }
    if (!managedTunnelPublicBaseUrl) {
      throw new Error("DEVPILOT_TUNNEL_PUBLIC_BASE_URL is required for managed-command tunnels.");
    }
  }
  if (provider === "openai-secure") {
    if (!openAiTunnelId || !OPENAI_TUNNEL_ID.test(openAiTunnelId)) {
      throw new Error("DEVPILOT_OPENAI_TUNNEL_ID must be tunnel_ followed by 32 lowercase hexadecimal characters.");
    }
    if (!openAiTunnelApiKey) {
      throw new Error("DEVPILOT_OPENAI_TUNNEL_API_KEY (or CONTROL_PLANE_API_KEY) is required for OpenAI Secure MCP Tunnel.");
    }
  }
  return {
    host: env.DEVPILOT_CONTROL_HOST?.trim() || DEFAULT_CONTROL_HOST,
    port: positivePort(env.DEVPILOT_CONTROL_PORT, DEFAULT_CONTROL_PORT),
    tunnelProvider: provider,
    cloudflaredCommand: env.DEVPILOT_CLOUDFLARED?.trim() || "cloudflared",
    openAiTunnelClientCommand: env.DEVPILOT_OPENAI_TUNNEL_CLIENT?.trim() || "tunnel-client",
    openAiTunnelId,
    openAiTunnelApiKey,
    openAiControlPlaneProxy,
    openAiTunnelHealthAddr: env.DEVPILOT_OPENAI_TUNNEL_HEALTH_ADDR?.trim() || DEFAULT_OPENAI_TUNNEL_HEALTH_ADDR,
    managedTunnelCommand,
    managedTunnelArgs,
    managedTunnelPublicBaseUrl,
    autoStart: env.DEVPILOT_AUTOSTART === undefined ? true : parseBoolean(env.DEVPILOT_AUTOSTART),
  };
}

export function parseCloudflareQuickTunnelUrl(output: string): string | undefined {
  const matches = output.match(CLOUDFLARE_QUICK_URL);
  return matches?.[matches.length - 1]?.replace(/\/$/, "");
}

export async function spawnCloudflareQuickTunnel(input: {
  command: string;
  localOrigin: string;
  timeoutMs: number;
}): Promise<{ child: ChildProcessWithoutNullStreams; publicBaseUrl: string }> {
  const child = spawn(
    input.command,
    ["tunnel", "--no-autoupdate", "--url", input.localOrigin],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      env: process.env,
    },
  );
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

export async function spawnOpenAiSecureTunnel(input: {
  command: string;
  tunnelId: string;
  apiKey: string;
  controlPlaneProxy?: string;
  mcpServerUrl: string;
  healthListenAddr: string;
  timeoutMs: number;
}): Promise<{ child: ChildProcessWithoutNullStreams }> {
  const healthBaseUrl = openAiTunnelHealthBaseUrl(input.healthListenAddr);
  const noProxy = appendNoProxy(process.env.NO_PROXY ?? process.env.no_proxy, ["127.0.0.1", "localhost", "::1"]);
  const child = spawn(input.command, ["run"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      CONTROL_PLANE_API_KEY: input.apiKey,
      CONTROL_PLANE_TUNNEL_ID: input.tunnelId,
      ...(input.controlPlaneProxy ? { CONTROL_PLANE_HTTP_PROXY: input.controlPlaneProxy } : {}),
      MCP_SERVER_URL: input.mcpServerUrl,
      HEALTH_LISTEN_ADDR: input.healthListenAddr,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    },
  });
  child.stdin.end();

  let output = "";
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-16_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Unable to start tunnel-client: ${error.message}`));
    });
  });

  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = redactSecret(output.trim(), input.apiKey);
      throw new Error(`tunnel-client exited before becoming ready${detail ? `: ${detail}` : "."}`);
    }
    try {
      const response = await fetch(`${healthBaseUrl}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return { child };
    } catch {
      // The health listener may not be bound yet.
    }
    await delay(250);
  }

  terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
  const detail = redactSecret(output.trim(), input.apiKey);
  throw new Error(`OpenAI Secure MCP Tunnel did not become ready within ${input.timeoutMs}ms${detail ? `: ${detail}` : "."}`);
}

export async function spawnManagedTunnelCommand(input: {
  command: string;
  args: string[];
}): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(input.command, input.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    env: process.env,
  });
  child.stdin.end();
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Unable to start managed tunnel command: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Managed tunnel command exited during startup (${signal ?? code ?? "unknown"}).`));
    });
  });
  return child;
}

function validateSupervisorConfig(config: DevPilotSupervisorConfig): void {
  if (config.tunnelProvider === "openai-secure") {
    if (!config.openAiTunnelId || !OPENAI_TUNNEL_ID.test(config.openAiTunnelId)) {
      throw new Error("OpenAI Secure MCP Tunnel requires a valid tunnel id.");
    }
    if (!config.openAiTunnelApiKey?.trim()) {
      throw new Error("OpenAI Secure MCP Tunnel requires a runtime API key.");
    }
    openAiTunnelHealthBaseUrl(config.openAiTunnelHealthAddr);
    return;
  }
  if (config.tunnelProvider !== "managed-command") return;
  if (!config.managedTunnelCommand?.trim()) {
    throw new Error("managed-command tunnels require a tunnel command.");
  }
  if (!config.managedTunnelPublicBaseUrl) {
    throw new Error("managed-command tunnels require a public base URL.");
  }
  try {
    new URL(config.managedTunnelPublicBaseUrl);
  } catch {
    throw new Error(`Invalid managed tunnel public base URL: ${config.managedTunnelPublicBaseUrl}`);
  }
}

function tunnelProvider(value: string | undefined, publicBaseUrl: string): DevPilotTunnelProvider {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "none" ||
    normalized === "external" ||
    normalized === "cloudflare-quick" ||
    normalized === "openai-secure" ||
    normalized === "managed-command"
  ) return normalized;
  if (normalized) throw new Error(`Invalid DEVPILOT_TUNNEL_PROVIDER: ${value}`);
  return isLocalUrl(publicBaseUrl) ? "none" : "external";
}

function isManagedTunnelProvider(provider: DevPilotTunnelProvider): boolean {
  return provider === "cloudflare-quick" || provider === "openai-secure" || provider === "managed-command";
}

function parseJsonStringArray(value: string | undefined, name: string): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      throw new Error("expected a JSON array of strings");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid ${name}: ${errorMessage(error)}`);
  }
}

function openAiTunnelHealthBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("OpenAI tunnel health address is required.");
  const candidate = trimmed.startsWith("http://") || trimmed.startsWith("https://")
    ? trimmed
    : `http://${trimmed.startsWith(":") ? `127.0.0.1${trimmed}` : trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid OpenAI tunnel health address: ${value}`);
  }
  if (!isLocalUrl(parsed.toString())) {
    throw new Error("OpenAI tunnel health listener must remain loopback-only.");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function appendNoProxy(current: string | undefined, required: string[]): string {
  const entries = (current ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const value of required) {
    if (!entries.includes(value)) entries.push(value);
  }
  return entries.join(",");
}

function redactSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join("[REDACTED]") : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOptionalUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid DEVPILOT_TUNNEL_PUBLIC_BASE_URL: ${trimmed}`);
  }
}

function parseBoolean(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function positivePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid DEVPILOT_CONTROL_PORT: ${value}`);
  }
  return parsed;
}

function withPublicBaseUrl(config: ServerConfig, publicBaseUrl: string): ServerConfig {
  const hostname = new URL(publicBaseUrl).hostname;
  const allowedHosts = config.allowedHosts.includes("*")
    ? config.allowedHosts
    : Array.from(new Set([...config.allowedHosts, hostname]));
  return {
    ...config,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    toolMode: config.toolMode,
    subagents: config.subagents,
    allowedHosts,
  };
}

interface CompatibleDevspaceProbe {
  toolMode?: string;
}

async function probeCompatibleDevspaceServer(
  config: Pick<ServerConfig, "host" | "port">,
): Promise<CompatibleDevspaceProbe | undefined> {
  const headers = { host: loopbackHostHeader(config) };
  try {
    const healthResponse = await fetch(`${localOrigin(config)}/healthz`, {
      headers,
      signal: AbortSignal.timeout(900),
    });
    if (!healthResponse.ok) return undefined;
    const health = await healthResponse.json() as { ok?: unknown; name?: unknown };
    if (health.ok !== true || health.name !== "devspace") return undefined;

    let toolMode: string | undefined;
    try {
      const statusResponse = await fetch(`${localOrigin(config)}/devpilot/api/status`, {
        headers,
        signal: AbortSignal.timeout(900),
      });
      if (statusResponse.ok) {
        const status = await statusResponse.json() as {
          product?: unknown;
          server?: { toolMode?: unknown };
        };
        if (status.product === "DevPilot" && typeof status.server?.toolMode === "string") {
          toolMode = status.server.toolMode;
        }
      }
    } catch {
      // A plain DevSpace runtime is still compatible even without DevPilot control routes.
    }
    return { toolMode };
  } catch {
    return undefined;
  }
}

function localOrigin(config: Pick<ServerConfig, "host" | "port">): string {
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formatted}:${config.port}`;
}

function localMcpUrl(config: Pick<ServerConfig, "host" | "port">): string {
  return `${localOrigin(config)}/mcp`;
}

function loopbackHostHeader(config: Pick<ServerConfig, "port">): string {
  return `127.0.0.1:${config.port}`;
}

function isLocalUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function displayServerStatus(state: ManagedServiceState): DevPilotSupervisorStatus["server"]["status"] {
  switch (state) {
    case "running": return "online";
    case "stopped": return "offline";
    default: return state;
  }
}

function requireControlActionHeader() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.header("x-devpilot-control") !== "1") {
      res.status(403).json({ error: "DevPilot control action header is required." });
      return;
    }
    next();
  };
}

function parameter(req: Request, key: string): string {
  const value = req.params[key];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

async function actionResponse(
  res: Response,
  action: () => Promise<void>,
  status: () => Promise<DevPilotSupervisorStatus>,
): Promise<void> {
  try {
    await action();
    res.json(await status());
  } catch (error) {
    res.status(500).json({ error: errorMessage(error), status: await status() });
  }
}

async function actionResultResponse<T extends { isOk(): boolean; isErr(): boolean; error?: Error }>(
  res: Response,
  action: Promise<T>,
  status: () => Promise<DevPilotSupervisorStatus>,
): Promise<void> {
  try {
    const result = await action;
    if (result.isErr()) {
      res.status(500).json({ error: result.error?.message ?? "Action failed.", status: await status() });
      return;
    }
    res.json(await status());
  } catch (error) {
    res.status(500).json({ error: errorMessage(error), status: await status() });
  }
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
