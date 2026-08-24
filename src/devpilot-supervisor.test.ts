import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadConfig } from "./config.js";
import {
  DevPilotSupervisor,
  loadDevPilotSupervisorConfig,
  parseCloudflareQuickTunnelUrl,
} from "./devpilot-supervisor.js";

test("DevPilot supervisor defaults to external tunnel for a public MCP origin", () => {
  const config = loadDevPilotSupervisorConfig({}, { publicBaseUrl: "https://devpilot.example.com" });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 7680);
  assert.equal(config.tunnelProvider, "external");
  assert.equal(config.cloudflaredCommand, "cloudflared");
  assert.equal(config.autoStart, true);
});

test("DevPilot supervisor defaults to no tunnel for a loopback MCP origin", () => {
  const config = loadDevPilotSupervisorConfig({}, { publicBaseUrl: "http://127.0.0.1:7676" });
  assert.equal(config.tunnelProvider, "none");
});

test("DevPilot supervisor accepts explicit quick-tunnel and control settings", () => {
  const config = loadDevPilotSupervisorConfig({
    DEVPILOT_CONTROL_HOST: "127.0.0.1",
    DEVPILOT_CONTROL_PORT: "8765",
    DEVPILOT_TUNNEL_PROVIDER: "cloudflare-quick",
    DEVPILOT_CLOUDFLARED: "C:\\tools\\cloudflared.exe",
    DEVPILOT_AUTOSTART: "0",
  }, { publicBaseUrl: "http://127.0.0.1:7676" });
  assert.equal(config.port, 8765);
  assert.equal(config.tunnelProvider, "cloudflare-quick");
  assert.equal(config.cloudflaredCommand, "C:\\tools\\cloudflared.exe");
  assert.equal(config.autoStart, false);
});

test("DevPilot supervisor accepts OpenAI Secure MCP Tunnel settings without exposing the runtime key", () => {
  const config = loadDevPilotSupervisorConfig({
    DEVPILOT_TUNNEL_PROVIDER: "openai-secure",
    DEVPILOT_OPENAI_TUNNEL_CLIENT: "C:\\tools\\tunnel-client.exe",
    DEVPILOT_OPENAI_TUNNEL_ID: "tunnel_0123456789abcdef0123456789abcdef",
    DEVPILOT_OPENAI_TUNNEL_API_KEY: "sk-test-runtime-key",
    DEVPILOT_OPENAI_CONTROL_PLANE_PROXY: "http://127.0.0.1:10890",
    DEVPILOT_OPENAI_TUNNEL_HEALTH_ADDR: "127.0.0.1:8766",
  }, { publicBaseUrl: "http://127.0.0.1:7676" });
  assert.equal(config.tunnelProvider, "openai-secure");
  assert.equal(config.openAiTunnelClientCommand, "C:\\tools\\tunnel-client.exe");
  assert.equal(config.openAiTunnelId, "tunnel_0123456789abcdef0123456789abcdef");
  assert.equal(config.openAiTunnelApiKey, "sk-test-runtime-key");
  assert.equal(config.openAiControlPlaneProxy, "http://127.0.0.1:10890");
  assert.equal(config.openAiTunnelHealthAddr, "127.0.0.1:8766");
});

test("DevPilot supervisor accepts a generic managed tunnel command", () => {
  const config = loadDevPilotSupervisorConfig({
    DEVPILOT_TUNNEL_PROVIDER: "managed-command",
    DEVPILOT_TUNNEL_COMMAND: "proxy-tool",
    DEVPILOT_TUNNEL_ARGS_JSON: '["serve","--port","7676"]',
    DEVPILOT_TUNNEL_PUBLIC_BASE_URL: "https://mcp.example.com/",
  }, { publicBaseUrl: "http://127.0.0.1:7676" });
  assert.equal(config.tunnelProvider, "managed-command");
  assert.equal(config.managedTunnelCommand, "proxy-tool");
  assert.deepEqual(config.managedTunnelArgs, ["serve", "--port", "7676"]);
  assert.equal(config.managedTunnelPublicBaseUrl, "https://mcp.example.com");
});

test("Cloudflare Quick Tunnel URL parser extracts the latest published origin", () => {
  const log = [
    "INF Requesting new quick Tunnel on trycloudflare.com...",
    "INF + https://older-example.trycloudflare.com",
    "INF Your quick Tunnel has been created! Visit it at https://fresh-example.trycloudflare.com/",
  ].join("\n");
  assert.equal(parseCloudflareQuickTunnelUrl(log), "https://fresh-example.trycloudflare.com");
  assert.equal(parseCloudflareQuickTunnelUrl("no tunnel here"), undefined);
});

test("DevPilot supervisor rejects invalid provider and port settings", () => {
  assert.throws(
    () => loadDevPilotSupervisorConfig({ DEVPILOT_TUNNEL_PROVIDER: "magic" }, { publicBaseUrl: "http://127.0.0.1:7676" }),
    /Invalid DEVPILOT_TUNNEL_PROVIDER/,
  );
  assert.throws(
    () => loadDevPilotSupervisorConfig({ DEVPILOT_CONTROL_PORT: "70000" }, { publicBaseUrl: "http://127.0.0.1:7676" }),
    /Invalid DEVPILOT_CONTROL_PORT/,
  );
  assert.throws(
    () => loadDevPilotSupervisorConfig({ DEVPILOT_TUNNEL_PROVIDER: "managed-command" }, { publicBaseUrl: "http://127.0.0.1:7676" }),
    /DEVPILOT_TUNNEL_COMMAND is required/,
  );
  assert.throws(
    () => loadDevPilotSupervisorConfig({ DEVPILOT_TUNNEL_ARGS_JSON: "not-json" }, { publicBaseUrl: "http://127.0.0.1:7676" }),
    /Invalid DEVPILOT_TUNNEL_ARGS_JSON/,
  );
  assert.throws(
    () => loadDevPilotSupervisorConfig({
      DEVPILOT_TUNNEL_PROVIDER: "openai-secure",
      DEVPILOT_OPENAI_TUNNEL_API_KEY: "sk-test-runtime-key",
    }, { publicBaseUrl: "http://127.0.0.1:7676" }),
    /DEVPILOT_OPENAI_TUNNEL_ID/,
  );
  assert.throws(
    () => loadDevPilotSupervisorConfig({
      DEVPILOT_TUNNEL_PROVIDER: "openai-secure",
      DEVPILOT_OPENAI_TUNNEL_ID: "tunnel_0123456789abcdef0123456789abcdef",
    }, { publicBaseUrl: "http://127.0.0.1:7676" }),
    /DEVPILOT_OPENAI_TUNNEL_API_KEY/,
  );
});

test("DevPilot supervisor attaches to an existing compatible DevSpace runtime without taking ownership", async () => {
  const existing = createHttpServer((req, res) => {
    if (req.url === "/healthz") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, name: "devspace" }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    existing.once("error", reject);
    existing.listen(0, "127.0.0.1", resolve);
  });
  const existingAddress = existing.address() as AddressInfo;
  const serverConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: ".devpilot-supervisor-attach-test-config",
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_PUBLIC_BASE_URL: `http://127.0.0.1:${existingAddress.port}`,
    DEVSPACE_OAUTH_OWNER_TOKEN: "supervisor-attach-test-owner-token-long-enough",
    HOST: "127.0.0.1",
    PORT: String(existingAddress.port),
  });
  const offlineResult = {
    isOk: () => false,
    isErr: () => true,
    error: new Error("daemon offline"),
  };
  const supervisor = new DevPilotSupervisor({
    serverConfig,
    supervisorConfig: { port: 0, autoStart: false, tunnelProvider: "none" },
    providers: [],
    localAgentClient: {
      status: async () => offlineResult,
      ensureReady: async () => offlineResult,
      stop: async () => offlineResult,
    } as never,
    uiBuildDirectory: process.cwd(),
  });
  const control = await supervisor.listen();
  try {
    const status = await supervisor.status();
    assert.equal(status.server.status, "online");
    assert.equal(status.server.ownership, "external");
    assert.equal(status.server.managed, false);
    assert.equal(status.server.toolMode, "external");

    await supervisor.startServer();
    assert.equal((await supervisor.status()).server.ownership, "external");
    await supervisor.stopServer();

    const health = await fetch(`http://127.0.0.1:${existingAddress.port}/healthz`);
    assert.equal(health.status, 200, "stopping DevPilot must not terminate an attached external runtime");

    const controlAddress = control.address() as AddressInfo;
    const requests = await fetch(`http://127.0.0.1:${controlAddress.port}/devpilot/api/requests`);
    assert.equal(requests.status, 404, "plain attached DevSpace runtimes do not expose DevPilot request APIs");
  } finally {
    await supervisor.close();
    await new Promise<void>((resolve, reject) => existing.close((error) => error ? reject(error) : resolve()));
  }
});

test("DevPilot supervisor keeps its local control API alive while MCP server is stopped", async () => {
  const serverPort = await unusedLoopbackPort();
  const serverConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: ".devpilot-supervisor-test-config",
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_PUBLIC_BASE_URL: `http://127.0.0.1:${serverPort}`,
    DEVSPACE_OAUTH_OWNER_TOKEN: "supervisor-test-owner-token-long-enough",
    HOST: "127.0.0.1",
    PORT: String(serverPort),
  });
  const offlineResult = {
    isOk: () => false,
    isErr: () => true,
    error: new Error("daemon offline"),
  };
  const supervisor = new DevPilotSupervisor({
    serverConfig,
    supervisorConfig: { port: 0, autoStart: false, tunnelProvider: "none" },
    providers: [],
    localAgentClient: {
      status: async () => offlineResult,
      ensureReady: async () => offlineResult,
      stop: async () => offlineResult,
    } as never,
    uiBuildDirectory: process.cwd(),
  });
  const http = await supervisor.listen();
  try {
    const address = http.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const rootRoute = await fetch(`${baseUrl}/`, { redirect: "manual" });
    assert.equal(rootRoute.status, 302);
    assert.equal(rootRoute.headers.get("location"), "/devpilot/");
    const bareRoute = await fetch(`${baseUrl}/devpilot`, { redirect: "manual" });
    assert.equal(bareRoute.status, 308);
    assert.equal(bareRoute.headers.get("location"), "/devpilot/");
    const slashRoute = await fetch(`${baseUrl}/devpilot/`, { redirect: "manual" });
    assert.notEqual(slashRoute.status, 308);
    assert.equal(slashRoute.headers.get("location"), null);

    const response = await fetch(`${baseUrl}/devpilot/api/status`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      supervisor: { status: string };
      server: { status: string };
      tunnel: { provider: string; state: string };
    };
    assert.equal(payload.supervisor.status, "online");
    assert.equal(payload.server.status, "offline");
    assert.equal(payload.tunnel.provider, "none");
    assert.equal(payload.tunnel.state, "stopped");
  } finally {
    await supervisor.close();
  }
});

async function unusedLoopbackPort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
