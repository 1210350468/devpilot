import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import type { ServerConfig } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import type { LocalAgentClient } from "./local-agent-client.js";
import type { RequestObserver } from "./request-observer.js";
import { loadDevspaceFiles, writeDevspaceConfig } from "./user-config.js";

export interface RegisterControlCenterOptions {
  app: Express;
  config: ServerConfig;
  requestObserver: RequestObserver;
  localAgentClient?: LocalAgentClient;
  localAgentProviders: LocalAgentProviderAvailability[];
  uiBuildDirectory: string;
}

export function registerControlCenter(options: RegisterControlCenterOptions): void {
  const { app, config, requestObserver, localAgentClient, localAgentProviders, uiBuildDirectory } = options;
  const localOnly = localControlCenterOnly();

  app.get(/^\/devpilot$/, localOnly, (_req, res) => {
    res.redirect(308, "/devpilot/");
  });

  app.use(
    "/devpilot/assets",
    localOnly,
    express.static(join(uiBuildDirectory, "assets"), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
    }),
  );

  app.get("/devpilot/", localOnly, (_req, res) => {
    const htmlPath = join(uiBuildDirectory, "control-center.html");
    if (!existsSync(htmlPath)) {
      res.status(503).type("text/plain").send("DevPilot Control Center UI is not built yet. Run npm run build.");
      return;
    }
    res.sendFile(htmlPath);
  });

  app.get("/devpilot/api/status", localOnly, async (_req, res) => {
    const daemon = localAgentClient ? await localAgentClient.status() : undefined;
    const tunnel = await localTunnelStatus();
    const daemonStatus = daemon?.isOk()
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
          state: "offline" as const,
          reason: daemon?.isErr() ? daemon.error.message : "Local agent daemon is unavailable.",
        };

    res.json({
      product: "DevPilot",
      server: {
        status: "online",
        authMode: config.authMode,
        toolMode: config.toolMode,
        host: config.host,
        port: config.port,
        localMcpUrl: localMcpUrl(config),
        publicMcpUrl: tunnel.provider === "openai-secure" && tunnel.tunnelId
          ? `tunnel:${tunnel.tunnelId}`
          : new URL("/mcp", config.publicBaseUrl).toString(),
        publicEndpointConfigured: tunnel.provider === "openai-secure"
          ? tunnel.ready === true
          : !isLocalPublicBaseUrl(config.publicBaseUrl),
      },
      tunnel,
      daemon: daemonStatus,
      providers: localAgentProviders.map((provider) => ({
        name: provider.name,
        available: provider.available,
        note: provider.note,
        reason: provider.reason,
      })),
      requestObserver: {
        enabled: true,
        retained: requestObserver.list(200).length,
      },
    });
  });

  app.get("/devpilot/api/requests", localOnly, (req, res) => {
    const limit = queryPositiveInteger(req, "limit", 100, 200);
    const conversationScopeId = queryString(req, "conversationScopeId");
    res.json({ requests: requestObserver.list(limit, conversationScopeId) });
  });

  app.get("/devpilot/api/conversations", localOnly, (_req, res) => {
    res.json({ conversations: requestObserver.conversations() });
  });

  app.get("/devpilot/api/settings", localOnly, (_req, res) => {
    const files = loadDevspaceFiles();
    res.json({
      configPath: files.configPath,
      effective: {
        host: config.host,
        port: config.port,
        allowedRoots: config.allowedRoots,
        authMode: config.authMode,
        toolMode: config.toolMode,
        widgets: config.widgets,
        publicBaseUrl: config.publicBaseUrl,
      },
      saved: files.config,
    });
  });

  app.post("/devpilot/api/settings", localOnly, express.json({ limit: "32kb" }), (req, res) => {
    const body = req.body as Record<string, unknown>;
    const files = loadDevspaceFiles();
    const next = { ...files.config };
    if (typeof body.host === "string" && body.host.trim()) next.host = body.host.trim();
    if (typeof body.port === "number" && Number.isInteger(body.port) && body.port > 0 && body.port <= 65535) next.port = body.port;
    if (Array.isArray(body.allowedRoots) && body.allowedRoots.every((item) => typeof item === "string")) {
      next.allowedRoots = body.allowedRoots.map((item) => item.trim()).filter(Boolean);
    }
    if (body.authMode === "oauth" || body.authMode === "secure-tunnel") next.authMode = body.authMode;
    if (body.toolMode === "minimal" || body.toolMode === "full" || body.toolMode === "codex") next.toolMode = body.toolMode;
    if (body.widgets === "off" || body.widgets === "changes" || body.widgets === "full") next.widgets = body.widgets;
    if (typeof body.publicBaseUrl === "string") next.publicBaseUrl = body.publicBaseUrl.trim() || null;
    const configPath = writeDevspaceConfig(next);
    res.json({ ok: true, restartRequired: true, configPath, saved: next });
  });
}

export function localControlCenterOnly() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const socketAddress = normalizeAddress(req.socket.remoteAddress);
    const host = requestHostname(req);
    if (!isLoopbackAddress(socketAddress) || !isLoopbackHostname(host)) {
      res.status(404).end();
      return;
    }
    next();
  };
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = normalizeAddress(address);
  return normalized === "127.0.0.1" || normalized === "::1";
}

export function isLoopbackHostname(hostname: string | undefined): boolean {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function requestHostname(req: Request): string | undefined {
  const host = req.header("host")?.trim();
  if (!host) return undefined;
  if (host.startsWith("[")) {
    const closing = host.indexOf("]");
    return closing >= 0 ? host.slice(0, closing + 1) : host;
  }
  return host.split(":")[0];
}

function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const lowered = address.toLowerCase();
  if (lowered.startsWith("::ffff:")) return lowered.slice("::ffff:".length);
  return lowered;
}

function localMcpUrl(config: ServerConfig): string {
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formatted}:${config.port}/mcp`;
}

function isLocalPublicBaseUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

async function localTunnelStatus(): Promise<{
  provider: string;
  tunnelId?: string;
  ready?: boolean;
  healthUrl?: string;
}> {
  const provider = process.env.DEVPILOT_TUNNEL_PROVIDER?.trim() || "none";
  if (provider !== "openai-secure") return { provider };
  const tunnelId = process.env.DEVPILOT_OPENAI_TUNNEL_ID?.trim() || undefined;
  const address = process.env.DEVPILOT_OPENAI_TUNNEL_HEALTH_ADDR?.trim() || "127.0.0.1:7683";
  const healthUrl = address.startsWith("http://") || address.startsWith("https://")
    ? address.replace(/\/$/, "")
    : `http://${address.startsWith(":") ? `127.0.0.1${address}` : address}`;
  let ready = false;
  try {
    const response = await fetch(`${healthUrl}/readyz`, { signal: AbortSignal.timeout(700) });
    ready = response.ok;
  } catch {
    ready = false;
  }
  return { provider, tunnelId, ready, healthUrl };
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queryPositiveInteger(req: Request, key: string, fallback: number, maximum: number): number {
  const value = queryString(req, key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}
